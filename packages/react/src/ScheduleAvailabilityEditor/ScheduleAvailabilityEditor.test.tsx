// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  applyWeeklyAvailability,
  buildAvailabilityExtension,
  clearAvailabilityOverride,
  emptyWeeklyAvailability,
  getServiceSchedulingParameters,
  hasAvailabilityOverride,
  parseServiceAvailability,
  parseWeeklyAvailability,
  SchedulingParametersURI,
} from '@medplum/core';
import type { Extension, HealthcareService, Schedule } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react-hooks';
import { act, fireEvent, render, screen } from '../test-utils/render';
import { ScheduleAvailabilityEditor } from './ScheduleAvailabilityEditor';
import { validateWeeklyAvailability } from './ScheduleAvailabilityEditor.utils';

const service: HealthcareService = {
  resourceType: 'HealthcareService',
  id: 'service-1',
  name: 'New Patient Visit',
};

// A service with native availableTime, used to exercise the inherited default path.
const serviceWithHours: HealthcareService = {
  resourceType: 'HealthcareService',
  id: 'service-1',
  name: 'New Patient Visit',
  availableTime: [
    { daysOfWeek: ['mon', 'tue'], availableStartTime: '08:00:00', availableEndTime: '16:00:00' },
    { daysOfWeek: ['sat'], allDay: true },
  ],
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

// Schedule with a SchedulingParameters block for the service but no `availability`
// sub-extension, i.e. it inherits the service-level default.
function scheduleWithoutOverride(): Schedule {
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
        ],
      },
    ],
  };
}

function getAvailableTimes(schedule: Schedule): Extension[] {
  const params = getServiceSchedulingParameters(schedule, service);
  const availability = params?.extension?.find((sub) => sub.url === 'availability');
  return availability?.extension ?? [];
}

describe('ScheduleAvailabilityEditor utils', () => {
  test('parseWeeklyAvailability expands availableTime into per-day ranges', () => {
    const schedule = scheduleWith(
      availableTime('mon', '09:00:00', '12:00:00'),
      availableTime('wed', '09:00:00', '17:00:00')
    );
    const weekly = parseWeeklyAvailability(schedule, service);
    expect(weekly.mon).toEqual({ allDay: false, ranges: [{ start: '09:00:00', end: '12:00:00' }] });
    expect(weekly.wed).toEqual({ allDay: false, ranges: [{ start: '09:00:00', end: '17:00:00' }] });
    expect(weekly.tue).toEqual({ allDay: false, ranges: [] });
  });

  test('parseWeeklyAvailability supports multiple ranges per day', () => {
    const schedule = scheduleWith(
      availableTime('mon', '09:00:00', '12:00:00'),
      availableTime('mon', '13:00:00', '17:00:00')
    );
    const weekly = parseWeeklyAvailability(schedule, service);
    expect(weekly.mon.ranges).toEqual([
      { start: '09:00:00', end: '12:00:00' },
      { start: '13:00:00', end: '17:00:00' },
    ]);
  });

  test('parseWeeklyAvailability reads the allDay flag', () => {
    const schedule = scheduleWith(allDayTime('mon'), availableTime('wed', '09:00:00', '17:00:00'));
    const weekly = parseWeeklyAvailability(schedule, service);
    expect(weekly.mon).toEqual({ allDay: true, ranges: [] });
    expect(weekly.wed).toEqual({ allDay: false, ranges: [{ start: '09:00:00', end: '17:00:00' }] });
  });

  test('parseWeeklyAvailability returns empty availability when no matching service', () => {
    const otherService: HealthcareService = { resourceType: 'HealthcareService', id: 'other', name: 'Other' };
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    expect(parseWeeklyAvailability(schedule, otherService)).toEqual(emptyWeeklyAvailability());
  });

  test('buildAvailabilityExtension serializes one availableTime per range', () => {
    const weekly = emptyWeeklyAvailability();
    weekly.mon.ranges = [
      { start: '09:00:00', end: '12:00:00' },
      { start: '13:00:00', end: '17:00:00' },
    ];
    const ext = buildAvailabilityExtension(weekly);
    expect(ext.url).toBe('availability');
    expect(ext.extension).toHaveLength(2);
    expect(ext.extension?.[0].extension).toEqual([
      { url: 'daysOfWeek', valueCode: 'mon' },
      { url: 'availableStartTime', valueTime: '09:00:00' },
      { url: 'availableEndTime', valueTime: '12:00:00' },
    ]);
    expect(ext.extension?.[1].extension).toEqual([
      { url: 'daysOfWeek', valueCode: 'mon' },
      { url: 'availableStartTime', valueTime: '13:00:00' },
      { url: 'availableEndTime', valueTime: '17:00:00' },
    ]);
  });

  test('buildAvailabilityExtension serializes an allDay day with the allDay flag', () => {
    const weekly = emptyWeeklyAvailability();
    weekly.mon.allDay = true;
    // Ranges are ignored when allDay is set.
    weekly.mon.ranges = [{ start: '09:00:00', end: '12:00:00' }];
    const ext = buildAvailabilityExtension(weekly);
    expect(ext.extension).toHaveLength(1);
    expect(ext.extension?.[0].extension).toEqual([
      { url: 'daysOfWeek', valueCode: 'mon' },
      { url: 'allDay', valueBoolean: true },
    ]);
  });

  test('allDay round-trips through parse -> build -> parse', () => {
    const schedule = scheduleWith(allDayTime('sat'));
    const weekly = parseWeeklyAvailability(schedule, service);
    const updated = applyWeeklyAvailability(schedule, service, weekly);
    expect(parseWeeklyAvailability(updated, service)).toEqual(weekly);
  });

  test('parse -> build -> parse round-trips', () => {
    const schedule = scheduleWith(
      availableTime('mon', '09:00:00', '12:00:00'),
      availableTime('mon', '13:00:00', '17:00:00'),
      availableTime('fri', '08:00:00', '16:00:00')
    );
    const weekly = parseWeeklyAvailability(schedule, service);
    const updated = applyWeeklyAvailability(schedule, service, weekly);
    expect(parseWeeklyAvailability(updated, service)).toEqual(weekly);
  });

  test('applyWeeklyAvailability preserves sibling fields (service/duration)', () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const weekly = emptyWeeklyAvailability();
    weekly.tue.ranges = [{ start: '10:00:00', end: '14:00:00' }];
    const updated = applyWeeklyAvailability(schedule, service, weekly);

    const params = getServiceSchedulingParameters(updated, service);
    expect(params?.extension?.find((e) => e.url === 'service')?.valueReference?.reference).toBe(
      'HealthcareService/service-1'
    );
    expect(params?.extension?.find((e) => e.url === 'duration')?.valueDuration).toEqual({ value: 30, unit: 'min' });

    const times = getAvailableTimes(updated);
    expect(times).toHaveLength(1);
    expect(times[0].extension).toContainEqual({ url: 'daysOfWeek', valueCode: 'tue' });
  });

  test('applyWeeklyAvailability does not mutate the input schedule', () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const before = JSON.stringify(schedule);
    const weekly = emptyWeeklyAvailability();
    weekly.tue.ranges = [{ start: '10:00:00', end: '14:00:00' }];
    applyWeeklyAvailability(schedule, service, weekly);
    expect(JSON.stringify(schedule)).toBe(before);
  });

  test('applyWeeklyAvailability creates a SchedulingParameters entry when missing', () => {
    const schedule: Schedule = {
      resourceType: 'Schedule',
      id: 'schedule-empty',
      actor: [{ reference: 'Practitioner/123' }],
    };
    const weekly = emptyWeeklyAvailability();
    weekly.mon.ranges = [{ start: '09:00:00', end: '17:00:00' }];
    const updated = applyWeeklyAvailability(schedule, service, weekly);

    const params = getServiceSchedulingParameters(updated, service);
    expect(params).toBeDefined();
    expect(params?.extension?.find((e) => e.url === 'service')?.valueReference?.reference).toBe(
      'HealthcareService/service-1'
    );
    expect(getAvailableTimes(updated)).toHaveLength(1);
  });

  test('validateWeeklyAvailability flags end <= start and overlaps', () => {
    const weekly = emptyWeeklyAvailability();
    weekly.mon.ranges = [{ start: '17:00:00', end: '09:00:00' }];
    expect(validateWeeklyAvailability(weekly).valid).toBe(false);

    const overlap = emptyWeeklyAvailability();
    overlap.tue.ranges = [
      { start: '09:00:00', end: '13:00:00' },
      { start: '12:00:00', end: '15:00:00' },
    ];
    expect(validateWeeklyAvailability(overlap).valid).toBe(false);

    const ok = emptyWeeklyAvailability();
    ok.wed.ranges = [{ start: '09:00:00', end: '17:00:00' }];
    expect(validateWeeklyAvailability(ok).valid).toBe(true);
  });

  test('validateWeeklyAvailability treats allDay days as valid', () => {
    const weekly = emptyWeeklyAvailability();
    weekly.mon.allDay = true;
    expect(validateWeeklyAvailability(weekly).valid).toBe(true);
  });

  test('parseServiceAvailability expands HealthcareService.availableTime', () => {
    const weekly = parseServiceAvailability(serviceWithHours);
    expect(weekly.mon).toEqual({ allDay: false, ranges: [{ start: '08:00:00', end: '16:00:00' }] });
    expect(weekly.tue).toEqual({ allDay: false, ranges: [{ start: '08:00:00', end: '16:00:00' }] });
    expect(weekly.sat).toEqual({ allDay: true, ranges: [] });
    expect(weekly.wed).toEqual({ allDay: false, ranges: [] });
  });

  test('hasAvailabilityOverride reflects presence of the availability sub-extension', () => {
    expect(hasAvailabilityOverride(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')), service)).toBe(true);
    expect(hasAvailabilityOverride(scheduleWithoutOverride(), service)).toBe(false);
    const empty: Schedule = { resourceType: 'Schedule', id: 's', actor: [{ reference: 'Practitioner/1' }] };
    expect(hasAvailabilityOverride(empty, service)).toBe(false);
  });

  test('clearAvailabilityOverride removes the availability sub-extension but keeps siblings', () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const updated = clearAvailabilityOverride(schedule, service);

    expect(hasAvailabilityOverride(updated, service)).toBe(false);
    const params = getServiceSchedulingParameters(updated, service);
    expect(params?.extension?.find((e) => e.url === 'service')?.valueReference?.reference).toBe(
      'HealthcareService/service-1'
    );
    expect(params?.extension?.find((e) => e.url === 'duration')?.valueDuration).toEqual({ value: 30, unit: 'min' });
  });

  test('clearAvailabilityOverride does not mutate the input schedule', () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const before = JSON.stringify(schedule);
    clearAvailabilityOverride(schedule, service);
    expect(JSON.stringify(schedule)).toBe(before);
  });
});

describe('ScheduleAvailabilityEditor component', () => {
  function setup(
    schedule: Schedule,
    onSave = vi.fn(),
    onClose = vi.fn(),
    svc: HealthcareService = service
  ): { onSave: any; onClose: any } {
    render(
      <MedplumProvider medplum={new MockClient()}>
        <ScheduleAvailabilityEditor schedule={schedule} service={svc} opened={true} onClose={onClose} onSave={onSave} />
      </MedplumProvider>
    );
    return { onSave, onClose };
  }

  test('renders existing availability and saves an updated Schedule', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave } = setup(schedule);

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('09:00');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const updated: Schedule = onSave.mock.calls[0][0];
    const times = getAvailableTimes(updated);
    expect(times).toHaveLength(1);
    expect(times[0].extension).toContainEqual({ url: 'daysOfWeek', valueCode: 'mon' });
  });

  test('toggling a day on adds a default range and saves it', async () => {
    const schedule = scheduleWith();
    const { onSave } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-tue'));
    });
    expect(screen.getByTestId('schedule-availability-start-tue-0')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    const updated: Schedule = onSave.mock.calls[0][0];
    const weekly = parseWeeklyAvailability(updated, service);
    expect(weekly.tue.ranges).toHaveLength(1);
  });

  test('supports adding and removing multiple ranges per day', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '12:00:00'));
    const { onSave } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-add-mon'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-start-mon-1'), { target: { value: '13:00' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-end-mon-1'), { target: { value: '17:00' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    const updated: Schedule = onSave.mock.calls[0][0];
    const weekly = parseWeeklyAvailability(updated, service);
    expect(weekly.mon.ranges).toEqual([
      { start: '09:00:00', end: '12:00:00' },
      { start: '13:00:00', end: '17:00:00' },
    ]);
  });

  test('toggling all day hides the range editor and saves the allDay flag', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-all-day-mon'));
    });
    expect(screen.queryByTestId('schedule-availability-start-mon-0')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    const updated: Schedule = onSave.mock.calls[0][0];
    const weekly = parseWeeklyAvailability(updated, service);
    expect(weekly.mon).toEqual({ allDay: true, ranges: [] });
  });

  test('Cancel does not call onSave', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave, onClose } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test('invalid range disables Save', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    setup(schedule);

    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-end-mon-0'), { target: { value: '08:00' } });
    });

    expect(screen.getByTestId('schedule-availability-error-mon')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('clearing a time input reports a missing time and disables Save', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave } = setup(schedule);

    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-start-mon-0'), { target: { value: '' } });
    });

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('');
    expect(screen.getByTestId('schedule-availability-error-mon')).toHaveTextContent('Start and end times are required');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  test('seeds from the service default and shows the default badge when there is no override', () => {
    setup(scheduleWithoutOverride(), vi.fn(), vi.fn(), serviceWithHours);

    expect(screen.getByTestId('schedule-availability-default-badge')).toBeDefined();
    expect(screen.queryByTestId('schedule-availability-override-badge')).toBeNull();
    // Monday is seeded from the service default hours.
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('08:00');
    // Reset is disabled while inheriting.
    expect(screen.getByTestId('schedule-availability-reset')).toBeDisabled();
  });

  test('saving without edits while inheriting clears any override', async () => {
    const { onSave } = setup(scheduleWithoutOverride(), vi.fn(), vi.fn(), serviceWithHours);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(false);
  });

  test('editing while inheriting creates an override', async () => {
    const { onSave } = setup(scheduleWithoutOverride(), vi.fn(), vi.fn(), serviceWithHours);

    expect(screen.getByTestId('schedule-availability-default-badge')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-wed'));
    });

    expect(screen.getByTestId('schedule-availability-override-badge')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(true);
  });

  test('reset to service default discards the override', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave } = setup(schedule, vi.fn(), vi.fn(), serviceWithHours);

    expect(screen.getByTestId('schedule-availability-override-badge')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-reset'));
    });

    expect(screen.getByTestId('schedule-availability-default-badge')).toBeDefined();
    // After reset, the editor shows the service default hours (Monday 08:00).
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('08:00');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(false);
  });
});
