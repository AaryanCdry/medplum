// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DayOfWeek, WeeklyAvailability } from '@medplum/core';
import { DAYS_OF_WEEK } from '@medplum/core';

export const DAY_LABELS: Record<DayOfWeek, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface WeeklyAvailabilityValidation {
  readonly valid: boolean;
  readonly errors: Partial<Record<DayOfWeek, string>>;
}

/** Returns true when at least one day is available (all-day or has a range). */
export function hasAnyAvailableDay(weekly: WeeklyAvailability): boolean {
  return DAYS_OF_WEEK.some((day) => weekly[day].allDay || weekly[day].ranges.length > 0);
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
