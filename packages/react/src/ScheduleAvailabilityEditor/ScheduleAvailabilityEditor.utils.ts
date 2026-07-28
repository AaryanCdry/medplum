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

/**
 * Returns the day following the given one, wrapping from Sunday to Monday.
 * @param day - The day to advance from
 * @returns The next day of the week
 */
export function nextDayOfWeek(day: DayOfWeek): DayOfWeek {
  return DAYS_OF_WEEK[(DAYS_OF_WEEK.indexOf(day) + 1) % DAYS_OF_WEEK.length];
}

// Seconds since midnight, or undefined when the time is missing or malformed.
// FHIR `time` has no timezone, so this is a plain offset into the day. Seconds
// are optional here because the inputs emit `HH:mm`, and fractional seconds are
// accepted because FHIR `time` permits them.
function toSecondsOfDay(time: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(time);
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

// Scheduling reads `end <= start` as continuing past midnight, so both an
// overnight window and a same-time (24 hour) window carry into the next day.
function wrapsIntoNextDay(range: TimeRange): boolean {
  const start = toSecondsOfDay(range.start);
  const end = toSecondsOfDay(range.end);
  return start !== undefined && end !== undefined && end <= start;
}

/**
 * Returns whether a range runs past midnight into the following day.
 *
 * Scheduling reads an end time before the start time as continuing into the next
 * day, so `22:00` to `06:00` means 10pm until 6am the next morning.
 * @param range - The range to inspect
 * @returns True when the range ends on the day after it starts
 */
export function isOvernightRange(range: TimeRange): boolean {
  const start = toSecondsOfDay(range.start);
  const end = toSecondsOfDay(range.end);
  return start !== undefined && end !== undefined && end < start;
}

/**
 * Returns whether a range starts and ends at the same time, which scheduling
 * reads as a full 24 hours rather than an empty window. `allDay` expresses the
 * same thing more clearly, so the editor steers toward it.
 * @param range - The range to inspect
 * @returns True when start and end are the same time
 */
export function isFullDayRange(range: TimeRange): boolean {
  const start = toSecondsOfDay(range.start);
  const end = toSecondsOfDay(range.end);
  return start !== undefined && end !== undefined && start === end;
}

/** Availability that lands on a day from a window that started the day before. */
export interface DaySpillover {
  /** The day the window started on. */
  readonly from: DayOfWeek;
  /** The time the window ends, on the day it spills into. */
  readonly end: string;
}

/**
 * Finds availability that lands on days the editor shows as unavailable.
 *
 * Scheduling keys a window to its start day, so a Friday window ending at 6am
 * also makes Saturday morning bookable even when Saturday has no hours of its
 * own. The per-day cards would otherwise hide that, so the editor surfaces it.
 * @param weekly - Day-keyed availability to inspect
 * @returns Spillover keyed by the day receiving it, for unavailable days only
 */
export function getSpilloverByDay(weekly: WeeklyAvailability): Partial<Record<DayOfWeek, DaySpillover[]>> {
  const spillover: Partial<Record<DayOfWeek, DaySpillover[]>> = {};

  for (const from of DAYS_OF_WEEK) {
    if (weekly[from].allDay) {
      continue;
    }
    const to = nextDayOfWeek(from);
    // Days with their own hours already show availability, so only call out the
    // days that would otherwise read as fully unavailable.
    if (weekly[to].allDay || weekly[to].ranges.length > 0) {
      continue;
    }
    for (const range of weekly[from].ranges) {
      // A window ending exactly at midnight stops on the day boundary, so it
      // leaves no available time on the following day.
      if (!wrapsIntoNextDay(range) || toSecondsOfDay(range.end) === 0) {
        continue;
      }
      spillover[to] ??= [];
      spillover[to].push({ from, end: range.end });
    }
  }

  return spillover;
}

// Both times are required; beyond that a range is valid in any order, since
// scheduling reads `end <= start` as running into the next day. Empty days are
// valid too (interpreted as unavailable). Overlapping ranges are not flagged at
// all: the server merges them into one continuous window.
export function validateWeeklyAvailability(weekly: WeeklyAvailability): WeeklyAvailabilityValidation {
  const errors: Partial<Record<DayOfWeek, string>> = {};
  const warnings: Partial<Record<DayOfWeek, string>> = {};

  for (const day of DAYS_OF_WEEK) {
    if (weekly[day].allDay) {
      continue;
    }
    const ranges = weekly[day].ranges;

    if (ranges.some((range) => !range.start || !range.end)) {
      errors[day] = 'Start and end times are required';
      continue;
    }

    if (ranges.some(isFullDayRange)) {
      warnings[day] = 'A range ending at its start time covers a full 24 hours. Use "Available all day" instead.';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors, warnings };
}
