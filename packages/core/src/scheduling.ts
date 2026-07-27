// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { CodeableConcept, Extension, HealthcareService, Reference, Resource, Schedule } from '@medplum/fhirtypes';
import type { WithId } from './utils';
import { createReference, deepClone, getExtension, getExtensionValue, getReferenceString, isDefined } from './utils';

export const SchedulingParametersURI = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';
export const ServiceTypeReferenceURI = 'https://medplum.com/fhir/service-type-reference';
export const TimezoneExtensionURI = 'http://hl7.org/fhir/StructureDefinition/timezone';

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const DAYS_OF_WEEK: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

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

/**
 * Returns whether a Schedule or HealthcareService has a SchedulingParameters extension.
 * @param resource - Schedule or HealthcareService to inspect
 * @returns True if the resource has a SchedulingParameters extension
 */
export function hasSchedulingParameters(resource: Schedule | HealthcareService): boolean {
  return !!getExtension(resource, SchedulingParametersURI);
}

/**
 * Finds the SchedulingParameters extension on a Schedule for a HealthcareService.
 * @param schedule - Schedule to inspect
 * @param service - HealthcareService referenced by the desired parameters
 * @returns The matching SchedulingParameters extension, if present
 */
export function getServiceSchedulingParameters(schedule: Schedule, service: HealthcareService): Extension | undefined {
  const reference = createReference(service).reference;
  return schedule.extension?.find(
    (extension) =>
      extension.url === SchedulingParametersURI &&
      (extension.extension?.some(
        (subextension) => subextension.url === 'service' && subextension.valueReference?.reference === reference
      ) ??
        false)
  );
}

/**
 * Expands a Schedule's availability override into per-day availability.
 * @param schedule - Schedule containing the availability override
 * @param service - HealthcareService referenced by the desired parameters
 * @returns Weekly availability parsed from the matching override
 */
export function parseWeeklyAvailability(schedule: Schedule, service: HealthcareService): WeeklyAvailability {
  const weekly = emptyWeeklyAvailability();
  const parameters = getServiceSchedulingParameters(schedule, service);
  const availability = parameters?.extension?.find((subextension) => subextension.url === 'availability');

  for (const availableTime of availability?.extension ?? []) {
    if (availableTime.url !== 'availableTime') {
      continue;
    }
    const allDay = availableTime.extension?.find((extension) => extension.url === 'allDay')?.valueBoolean === true;
    const start = availableTime.extension?.find((extension) => extension.url === 'availableStartTime')?.valueTime;
    const end = availableTime.extension?.find((extension) => extension.url === 'availableEndTime')?.valueTime;
    if (!allDay && (!start || !end)) {
      continue;
    }
    for (const dayExtension of availableTime.extension ?? []) {
      if (dayExtension.url === 'daysOfWeek' && isDayOfWeek(dayExtension.valueCode)) {
        if (allDay) {
          weekly[dayExtension.valueCode].allDay = true;
        } else {
          weekly[dayExtension.valueCode].ranges.push({ start: start as string, end: end as string });
        }
      }
    }
  }

  return weekly;
}

/**
 * Expands a HealthcareService's native availableTime field into per-day availability.
 * @param service - HealthcareService containing default availability
 * @returns Weekly availability parsed from the service
 */
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

/**
 * Returns whether a Schedule overrides a HealthcareService's default availability.
 * @param schedule - Schedule to inspect
 * @param service - HealthcareService referenced by the desired parameters
 * @returns True if matching parameters contain an availability override
 */
export function hasAvailabilityOverride(schedule: Schedule, service: HealthcareService): boolean {
  const parameters = getServiceSchedulingParameters(schedule, service);
  return parameters?.extension?.some((subextension) => subextension.url === 'availability') ?? false;
}

/**
 * Builds the SchedulingParameters availability sub-extension.
 * @param weekly - Weekly availability to serialize
 * @returns An availability extension containing availableTime entries
 */
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

/**
 * Immutably applies weekly availability to a Schedule for a HealthcareService.
 * @param schedule - Schedule to update
 * @param service - HealthcareService referenced by the parameters
 * @param weekly - Weekly availability to apply
 * @returns A cloned Schedule containing the availability override
 */
export function applyWeeklyAvailability(
  schedule: Schedule,
  service: HealthcareService,
  weekly: WeeklyAvailability
): Schedule {
  const updated = deepClone(schedule);
  const serviceReference = createReference(service);
  const availabilityExtension = buildAvailabilityExtension(weekly);

  updated.extension = updated.extension ? [...updated.extension] : [];

  let parameters = updated.extension.find(
    (extension) =>
      extension.url === SchedulingParametersURI &&
      (extension.extension?.some(
        (subextension) =>
          subextension.url === 'service' && subextension.valueReference?.reference === serviceReference.reference
      ) ??
        false)
  );

  if (!parameters) {
    parameters = {
      url: SchedulingParametersURI,
      extension: [{ url: 'service', valueReference: serviceReference }],
    };
    updated.extension.push(parameters);
  }

  parameters.extension = [
    ...(parameters.extension?.filter((subextension) => subextension.url !== 'availability') ?? []),
    availabilityExtension,
  ];

  return updated;
}

/**
 * Immutably clears a Schedule's availability override for a HealthcareService.
 * @param schedule - Schedule to update
 * @param service - HealthcareService referenced by the parameters
 * @returns A cloned Schedule without the matching availability override
 */
export function clearAvailabilityOverride(schedule: Schedule, service: HealthcareService): Schedule {
  const updated = deepClone(schedule);
  const serviceReference = createReference(service);

  const parameters = updated.extension?.find(
    (extension) =>
      extension.url === SchedulingParametersURI &&
      (extension.extension?.some(
        (subextension) =>
          subextension.url === 'service' && subextension.valueReference?.reference === serviceReference.reference
      ) ??
        false)
  );

  if (parameters?.extension) {
    parameters.extension = parameters.extension.filter((subextension) => subextension.url !== 'availability');
  }

  return updated;
}

/**
 * Resolves the timezone used by scheduling in server priority order:
 * Schedule parameters, HealthcareService parameters, then the actor's standard
 * FHIR timezone extension.
 * @param schedule - Schedule whose parameters may define a timezone
 * @param service - HealthcareService whose parameters may define a timezone
 * @param actor - Optional Schedule actor used as a timezone fallback
 * @returns The resolved IANA timezone identifier, if present
 */
export function getSchedulingTimezone(
  schedule: Schedule,
  service: HealthcareService,
  actor?: Resource
): string | undefined {
  const scheduleParameters = getServiceSchedulingParameters(schedule, service);
  const scheduleTimezone = scheduleParameters?.extension?.find(
    (subextension) => subextension.url === 'timezone'
  )?.valueCode;
  if (scheduleTimezone) {
    return scheduleTimezone;
  }

  const serviceParameters = getExtension(service, SchedulingParametersURI);
  const serviceTimezone = serviceParameters?.extension?.find(
    (subextension) => subextension.url === 'timezone'
  )?.valueCode;
  if (serviceTimezone) {
    return serviceTimezone;
  }

  const actorTimezone = actor && getExtensionValue(actor, TimezoneExtensionURI);
  return typeof actorTimezone === 'string' ? actorTimezone : undefined;
}

/**
 * Converts a HealthcareService into an R4 CodeableConcept representation of
 * CodeableReference<HealthcareService>.
 * @param service - HealthcareService to represent
 * @returns CodeableConcept values containing a reference to the service
 */
export function toCodeableReferenceLike(service: WithId<HealthcareService>): CodeableConcept[] {
  const extension = [{ url: ServiceTypeReferenceURI, valueReference: createReference(service) }];
  if (!service.type?.length) {
    return [{ extension }];
  }
  return service.type.map((concept) => ({
    ...concept,
    extension: [...(concept.extension ?? []), ...extension],
  }));
}

/**
 * Returns whether any CodeableReference-like concept refers to the service.
 * @param serviceType - CodeableConcept values to inspect
 * @param service - HealthcareService or reference to match
 * @returns True if any concept references the service
 */
export function isCodeableReferenceLikeTo(
  serviceType: CodeableConcept[] | undefined,
  service: WithId<HealthcareService> | (Reference<HealthcareService> & { reference: string })
): boolean {
  if (!serviceType?.length) {
    return false;
  }
  const reference = getReferenceString(service);
  return serviceType.some((concept) => {
    const serviceReference = getExtensionValue(concept, ServiceTypeReferenceURI) as
      Reference<HealthcareService> | undefined;
    return serviceReference?.reference === reference;
  });
}

/**
 * Extracts HealthcareService references from CodeableReference-like concepts.
 * @param serviceType - CodeableConcept values to inspect
 * @returns HealthcareService references embedded in the concepts
 */
export function extractReferencesFromCodeableReferenceLike(
  serviceType: CodeableConcept[] | undefined
): Reference<HealthcareService>[] {
  if (!serviceType?.length) {
    return [];
  }
  return serviceType
    .map((concept) => getExtensionValue(concept, ServiceTypeReferenceURI) as Reference<HealthcareService> | undefined)
    .filter(isDefined);
}
