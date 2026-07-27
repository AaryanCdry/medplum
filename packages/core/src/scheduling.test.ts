// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Extension, HealthcareService, Practitioner, Schedule } from '@medplum/fhirtypes';
import {
  applyWeeklyAvailability,
  buildAvailabilityExtension,
  clearAvailabilityOverride,
  emptyWeeklyAvailability,
  extractReferencesFromCodeableReferenceLike,
  getSchedulingTimezone,
  getServiceSchedulingParameters,
  hasAvailabilityOverride,
  isCodeableReferenceLikeTo,
  parseServiceAvailability,
  parseWeeklyAvailability,
  SchedulingParametersURI,
  TimezoneExtensionURI,
  toCodeableReferenceLike,
} from './scheduling';

const service: HealthcareService = {
  resourceType: 'HealthcareService',
  id: 'service-1',
  name: 'Office visit',
};

function availableTime(day: string, start: string, end: string): Extension {
  return {
    url: 'availableTime',
    extension: [
      { url: 'daysOfWeek', valueCode: day },
      { url: 'availableStartTime', valueTime: start },
      { url: 'availableEndTime', valueTime: end },
    ],
  };
}

function allDayTime(day: string): Extension {
  return {
    url: 'availableTime',
    extension: [
      { url: 'daysOfWeek', valueCode: day },
      { url: 'allDay', valueBoolean: true },
    ],
  };
}

function scheduleWith(...availability: Extension[]): Schedule {
  return {
    resourceType: 'Schedule',
    id: 'schedule-1',
    actor: [{ reference: 'Practitioner/123' }],
    extension: [
      {
        url: SchedulingParametersURI,
        extension: [
          { url: 'service', valueReference: { reference: 'HealthcareService/service-1' } },
          { url: 'duration', valueDuration: { value: 30, unit: 'min' } },
          { url: 'availability', extension: availability },
        ],
      },
    ],
  };
}

describe('weekly scheduling availability', () => {
  test('parses ranges and all-day availability', () => {
    const weekly = parseWeeklyAvailability(
      scheduleWith(
        availableTime('mon', '09:00:00', '12:00:00'),
        availableTime('mon', '13:00:00', '17:00:00'),
        allDayTime('sat')
      ),
      service
    );

    expect(weekly.mon).toEqual({
      allDay: false,
      ranges: [
        { start: '09:00:00', end: '12:00:00' },
        { start: '13:00:00', end: '17:00:00' },
      ],
    });
    expect(weekly.sat).toEqual({ allDay: true, ranges: [] });
    expect(weekly.tue).toEqual({ allDay: false, ranges: [] });
  });

  test('parses HealthcareService defaults', () => {
    const weekly = parseServiceAvailability({
      ...service,
      availableTime: [
        { daysOfWeek: ['tue'], availableStartTime: '08:00:00', availableEndTime: '16:00:00' },
        { daysOfWeek: ['sun'], allDay: true },
      ],
    });

    expect(weekly.tue.ranges).toEqual([{ start: '08:00:00', end: '16:00:00' }]);
    expect(weekly.sun.allDay).toBe(true);
  });

  test('builds and round-trips availability', () => {
    const weekly = emptyWeeklyAvailability();
    weekly.mon.ranges = [{ start: '09:00:00', end: '17:00:00' }];
    weekly.sat.allDay = true;

    const extension = buildAvailabilityExtension(weekly);
    expect(extension.url).toBe('availability');
    expect(extension.extension).toHaveLength(2);

    const updated = applyWeeklyAvailability(scheduleWith(), service, weekly);
    expect(parseWeeklyAvailability(updated, service)).toEqual(weekly);
  });

  test('applies and clears an override without mutating input or sibling parameters', () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const before = structuredClone(schedule);
    const weekly = emptyWeeklyAvailability();
    weekly.tue.ranges = [{ start: '10:00:00', end: '14:00:00' }];

    const updated = applyWeeklyAvailability(schedule, service, weekly);
    expect(schedule).toEqual(before);
    expect(hasAvailabilityOverride(updated, service)).toBe(true);
    expect(
      getServiceSchedulingParameters(updated, service)?.extension?.find((extension) => extension.url === 'duration')
        ?.valueDuration
    ).toEqual({ value: 30, unit: 'min' });

    const cleared = clearAvailabilityOverride(updated, service);
    expect(hasAvailabilityOverride(cleared, service)).toBe(false);
    expect(
      getServiceSchedulingParameters(cleared, service)?.extension?.find((extension) => extension.url === 'duration')
        ?.valueDuration
    ).toEqual({ value: 30, unit: 'min' });
  });

  test('creates service-specific SchedulingParameters when missing', () => {
    const schedule: Schedule = {
      resourceType: 'Schedule',
      actor: [{ reference: 'Practitioner/123' }],
    };
    const weekly = emptyWeeklyAvailability();
    weekly.wed.ranges = [{ start: '09:00:00', end: '17:00:00' }];

    const updated = applyWeeklyAvailability(schedule, service, weekly);
    expect(getServiceSchedulingParameters(updated, service)).toBeDefined();
    expect(parseWeeklyAvailability(updated, service).wed.ranges).toHaveLength(1);
  });
});

describe('getSchedulingTimezone', () => {
  const actor: Practitioner = {
    resourceType: 'Practitioner',
    extension: [{ url: TimezoneExtensionURI, valueCode: 'America/Los_Angeles' }],
  };
  const serviceWithTimezone: HealthcareService = {
    ...service,
    extension: [
      {
        url: SchedulingParametersURI,
        extension: [{ url: 'timezone', valueCode: 'America/Chicago' }],
      },
    ],
  };

  test('uses actor timezone as the fallback', () => {
    expect(getSchedulingTimezone(scheduleWith(), service, actor)).toBe('America/Los_Angeles');
  });

  test('prefers HealthcareService scheduling parameters over actor', () => {
    expect(getSchedulingTimezone(scheduleWith(), serviceWithTimezone, actor)).toBe('America/Chicago');
  });

  test('prefers Schedule scheduling parameters over service and actor', () => {
    const schedule = scheduleWith();
    getServiceSchedulingParameters(schedule, service)?.extension?.push({
      url: 'timezone',
      valueCode: 'America/New_York',
    });
    expect(getSchedulingTimezone(schedule, serviceWithTimezone, actor)).toBe('America/New_York');
  });
});

describe('CodeableReference-like service types', () => {
  test('converts, matches, and extracts HealthcareService references', () => {
    const serviceWithId = { ...service, id: 'service-1' };
    const serviceType = toCodeableReferenceLike(serviceWithId);

    expect(isCodeableReferenceLikeTo(serviceType, serviceWithId)).toBe(true);
    expect(extractReferencesFromCodeableReferenceLike(serviceType)).toEqual([
      expect.objectContaining({ reference: 'HealthcareService/service-1' }),
    ]);
  });

  test('preserves service type coding while adding a reference', () => {
    const serviceWithType = {
      ...service,
      id: 'service-1',
      type: [{ coding: [{ system: 'http://example.com/service', code: 'office' }] }],
    };
    const serviceType = toCodeableReferenceLike(serviceWithType);

    expect(serviceType[0].coding?.[0].code).toBe('office');
    expect(isCodeableReferenceLikeTo(serviceType, serviceWithType)).toBe(true);
  });
});
