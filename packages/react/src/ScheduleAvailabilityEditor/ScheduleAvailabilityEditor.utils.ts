// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DayOfWeek } from '@medplum/core';
import { DAYS_OF_WEEK, isDayOfWeek } from '@medplum/core';
import type { HealthcareServiceAvailableTime } from '@medplum/fhirtypes';

export const DAY_LABELS: Record<DayOfWeek, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

export interface DayAvailability {
  allDay: boolean;
  ranges: TimeRange[];
}

/**
 * A day-keyed view of availability. `HealthcareServiceAvailableTime` groups days
 * together under a shared time range, which is compact for storage but awkward
 * to edit one day at a time, so the editor pivots it into this shape.
 */
export type WeeklyAvailability = Record<DayOfWeek, DayAvailability>;

export interface WeeklyAvailabilityValidation {
  readonly valid: boolean;
  readonly errors: Partial<Record<DayOfWeek, string>>;
  readonly warnings: Partial<Record<DayOfWeek, string>>;
}

export function blankWeeklyAvailability(): WeeklyAvailability {
  const weekly = {} as WeeklyAvailability;
  for (const day of DAYS_OF_WEEK) {
    weekly[day] = { allDay: false, ranges: [] };
  }
  return weekly;
}

/**
 * Pivots availability entries into a day-keyed view for editing.
 * @param availableTime - Availability entries to pivot
 * @returns The equivalent day-keyed availability
 */
export function toWeeklyAvailability(availableTime: HealthcareServiceAvailableTime[] | undefined): WeeklyAvailability {
  const weekly = blankWeeklyAvailability();

  for (const entry of availableTime ?? []) {
    const allDay = entry.allDay === true;
    const { availableStartTime: start, availableEndTime: end } = entry;
    if (!allDay && (!start || !end)) {
      continue;
    }
    for (const day of entry.daysOfWeek ?? []) {
      if (!isDayOfWeek(day)) {
        continue;
      }
      if (allDay) {
        weekly[day].allDay = true;
      } else {
        weekly[day].ranges.push({ start: start as string, end: end as string });
      }
    }
  }

  return weekly;
}

/**
 * Flattens the day-keyed editor view back into availability entries.
 * @param weekly - Day-keyed availability to flatten
 * @returns One availability entry per all-day flag or time range
 */
export function fromWeeklyAvailability(weekly: WeeklyAvailability): HealthcareServiceAvailableTime[] {
  const availableTime: HealthcareServiceAvailableTime[] = [];
  for (const day of DAYS_OF_WEEK) {
    if (weekly[day].allDay) {
      availableTime.push({ daysOfWeek: [day], allDay: true });
      continue;
    }
    for (const range of weekly[day].ranges) {
      availableTime.push({ daysOfWeek: [day], availableStartTime: range.start, availableEndTime: range.end });
    }
  }
  return availableTime;
}

/**
 * Returns whether at least one day is available (all-day or has a range).
 * @param weekly - Day-keyed availability to inspect
 * @returns True when any day is available
 */
export function hasAnyAvailableDay(weekly: WeeklyAvailability): boolean {
  return DAYS_OF_WEEK.some((day) => weekly[day].allDay || weekly[day].ranges.length > 0);
}

// Validate that every range has end > start. Empty days are valid (interpreted
// as unavailable). Overlapping ranges within a day are only warned about: the
// server resolves them without trouble, but they usually indicate a mistake.
export function validateWeeklyAvailability(weekly: WeeklyAvailability): WeeklyAvailabilityValidation {
  const errors: Partial<Record<DayOfWeek, string>> = {};
  const warnings: Partial<Record<DayOfWeek, string>> = {};

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

    if (dayError) {
      errors[day] = dayError;
      continue;
    }

    if (ranges.length > 1) {
      const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end) {
          warnings[day] = 'Time ranges overlap';
          break;
        }
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors, warnings };
}
