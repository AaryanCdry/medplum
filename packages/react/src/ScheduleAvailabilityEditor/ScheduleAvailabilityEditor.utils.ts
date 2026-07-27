// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { createReference, deepClone, getExtensionValue } from '@medplum/core';
import type { Extension, HealthcareService, Schedule } from '@medplum/fhirtypes';

// Kept local to avoid a provider->react dependency. Mirrors
// packages/server/src/fhir/operations/utils/scheduling-parameters.ts and
// examples/medplum-provider/src/utils/scheduling.ts.
export const SchedulingParametersURI = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';

// Standard FHIR timezone extension, used only to display a read-only note about
// how the configured hours are interpreted.
const TimezoneExtensionURI = 'http://hl7.org/fhir/StructureDefinition/timezone';

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

// Ordered Monday..Sunday, matching how the editor renders days.
export const DAYS_OF_WEEK: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const DAY_LABELS: Record<DayOfWeek, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

// A single availability window. `start`/`end` are FHIR `time` values (HH:MM:SS).
export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

// Availability for a single day. When `allDay` is true, the day is available for
// the full 24 hours and `ranges` are ignored (the FHIR `availableTime.allDay`
// flag disallows `availableStartTime`/`availableEndTime`).
export interface DayAvailability {
  allDay: boolean;
  ranges: TimeRange[];
}

export type WeeklyAvailability = Record<DayOfWeek, DayAvailability>;

export function isDayOfWeek(value: string | undefined): value is DayOfWeek {
  return (
    value === 'mon' ||
    value === 'tue' ||
    value === 'wed' ||
    value === 'thu' ||
    value === 'fri' ||
    value === 'sat' ||
    value === 'sun'
  );
}

export function emptyWeeklyAvailability(): WeeklyAvailability {
  const weekly = {} as WeeklyAvailability;
  for (const day of DAYS_OF_WEEK) {
    weekly[day] = { allDay: false, ranges: [] };
  }
  return weekly;
}

// Find the `SchedulingParameters` extension on the Schedule whose `service`
// sub-extension references the given HealthcareService.
export function getServiceSchedulingParameters(schedule: Schedule, service: HealthcareService): Extension | undefined {
  const reference = createReference(service).reference;
  return schedule.extension?.find(
    (ext) =>
      ext.url === SchedulingParametersURI &&
      (ext.extension?.some((sub) => sub.url === 'service' && sub.valueReference?.reference === reference) ?? false)
  );
}

// Expand the `availability` sub-extension into per-day availability. Each
// `availableTime` entry may list multiple `daysOfWeek`; each receives the same
// window (or the all-day flag).
export function parseWeeklyAvailability(schedule: Schedule, service: HealthcareService): WeeklyAvailability {
  const weekly = emptyWeeklyAvailability();
  const params = getServiceSchedulingParameters(schedule, service);
  const availability = params?.extension?.find((sub) => sub.url === 'availability');

  for (const availableTime of availability?.extension ?? []) {
    if (availableTime.url !== 'availableTime') {
      continue;
    }
    const allDay = availableTime.extension?.find((e) => e.url === 'allDay')?.valueBoolean === true;
    const start = availableTime.extension?.find((e) => e.url === 'availableStartTime')?.valueTime;
    const end = availableTime.extension?.find((e) => e.url === 'availableEndTime')?.valueTime;
    if (!allDay && (!start || !end)) {
      continue;
    }
    for (const dayExt of availableTime.extension ?? []) {
      if (dayExt.url === 'daysOfWeek' && isDayOfWeek(dayExt.valueCode)) {
        if (allDay) {
          weekly[dayExt.valueCode].allDay = true;
        } else {
          weekly[dayExt.valueCode].ranges.push({ start: start as string, end: end as string });
        }
      }
    }
  }

  return weekly;
}

// Expand the HealthcareService's native `availableTime` field into per-day
// availability. This is the service-level default that a Schedule inherits when
// it has no `availability` override for the service.
export function parseServiceAvailability(service: HealthcareService): WeeklyAvailability {
  const weekly = emptyWeeklyAvailability();

  for (const available of service.availableTime ?? []) {
    const allDay = available.allDay === true;
    const start = available.availableStartTime;
    const end = available.availableEndTime;
    if (!allDay && (!start || !end)) {
      continue;
    }
    for (const day of available.daysOfWeek ?? []) {
      if (isDayOfWeek(day)) {
        if (allDay) {
          weekly[day].allDay = true;
        } else {
          weekly[day].ranges.push({ start: start as string, end: end as string });
        }
      }
    }
  }

  return weekly;
}

// Whether the Schedule defines its own `availability` for the service. When
// false, the Schedule inherits the service-level default (`HealthcareService.availableTime`).
export function hasAvailabilityOverride(schedule: Schedule, service: HealthcareService): boolean {
  const params = getServiceSchedulingParameters(schedule, service);
  return params?.extension?.some((sub) => sub.url === 'availability') ?? false;
}

// Build the `availability` sub-extension. All-day days serialize to a single
// `availableTime` with the `allDay` flag; otherwise one `availableTime` per
// (day, range) with a single `daysOfWeek` value code.
export function buildAvailabilityExtension(weekly: WeeklyAvailability): Extension {
  const availableTime: Extension[] = [];
  for (const day of DAYS_OF_WEEK) {
    if (weekly[day].allDay) {
      availableTime.push({
        url: 'availableTime',
        extension: [
          { url: 'daysOfWeek', valueCode: day },
          { url: 'allDay', valueBoolean: true },
        ],
      });
      continue;
    }
    for (const range of weekly[day].ranges) {
      availableTime.push({
        url: 'availableTime',
        extension: [
          { url: 'daysOfWeek', valueCode: day },
          { url: 'availableStartTime', valueTime: range.start },
          { url: 'availableEndTime', valueTime: range.end },
        ],
      });
    }
  }
  return { url: 'availability', extension: availableTime };
}

// Immutably apply the edited weekly availability to a copy of the Schedule.
// Preserves all sibling SchedulingParameters fields (service, duration,
// timezone, buffers, alignment) and creates the SchedulingParameters entry with
// `service` + `availability` if none exists for the target service.
export function applyWeeklyAvailability(
  schedule: Schedule,
  service: HealthcareService,
  weekly: WeeklyAvailability
): Schedule {
  const updated = deepClone(schedule);
  const serviceReference = createReference(service);
  const availabilityExt = buildAvailabilityExtension(weekly);

  updated.extension = updated.extension ? [...updated.extension] : [];

  let params = updated.extension.find(
    (ext) =>
      ext.url === SchedulingParametersURI &&
      (ext.extension?.some(
        (sub) => sub.url === 'service' && sub.valueReference?.reference === serviceReference.reference
      ) ??
        false)
  );

  if (!params) {
    params = {
      url: SchedulingParametersURI,
      extension: [{ url: 'service', valueReference: serviceReference }],
    };
    updated.extension.push(params);
  }

  // Replace the existing availability sub-extension (if any), preserving siblings.
  params.extension = [...(params.extension?.filter((sub) => sub.url !== 'availability') ?? []), availabilityExt];

  return updated;
}

// Immutably remove the `availability` override for the service so the Schedule
// falls back to inheriting the service-level default. Sibling SchedulingParameters
// fields (duration, timezone, buffers, alignment) are preserved.
export function clearAvailabilityOverride(schedule: Schedule, service: HealthcareService): Schedule {
  const updated = deepClone(schedule);
  const serviceReference = createReference(service);

  const params = updated.extension?.find(
    (ext) =>
      ext.url === SchedulingParametersURI &&
      (ext.extension?.some(
        (sub) => sub.url === 'service' && sub.valueReference?.reference === serviceReference.reference
      ) ??
        false)
  );

  if (params?.extension) {
    params.extension = params.extension.filter((sub) => sub.url !== 'availability');
  }

  return updated;
}

// Resolve the timezone used to interpret the configured hours, for display
// only. Checks the SchedulingParameters `timezone`, then the HealthcareService,
// then the Schedule's timezone extension.
export function getSchedulingTimezone(schedule: Schedule, service: HealthcareService): string | undefined {
  const params = getServiceSchedulingParameters(schedule, service);
  const paramsTimezone = params?.extension?.find((sub) => sub.url === 'timezone')?.valueCode;
  if (paramsTimezone) {
    return paramsTimezone;
  }

  const serviceTimezone = getExtensionValue(service, TimezoneExtensionURI);
  if (typeof serviceTimezone === 'string') {
    return serviceTimezone;
  }

  const scheduleTimezone = getExtensionValue(schedule, TimezoneExtensionURI);
  if (typeof scheduleTimezone === 'string') {
    return scheduleTimezone;
  }

  return undefined;
}

export interface WeeklyAvailabilityValidation {
  readonly valid: boolean;
  readonly errors: Partial<Record<DayOfWeek, string>>;
}

// Validate that every range has end > start and that ranges within a day do not
// overlap. Empty days are valid (interpreted as unavailable).
export function validateWeeklyAvailability(weekly: WeeklyAvailability): WeeklyAvailabilityValidation {
  const errors: Partial<Record<DayOfWeek, string>> = {};

  for (const day of DAYS_OF_WEEK) {
    if (weekly[day].allDay) {
      continue;
    }
    const ranges = weekly[day].ranges;
    let dayError: string | undefined;

    for (const range of ranges) {
      if (!range.start || !range.end) {
        dayError = 'Start and end times are required';
        break;
      }
      if (range.end <= range.start) {
        dayError = 'End time must be after start time';
        break;
      }
    }

    if (!dayError && ranges.length > 1) {
      const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end) {
          dayError = 'Time ranges must not overlap';
          break;
        }
      }
    }

    if (dayError) {
      errors[day] = dayError;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
