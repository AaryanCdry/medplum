// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  createReference,
  extractAvailability,
  hasAvailabilityOverride,
  SchedulingParametersURI,
  TimezoneExtensionURI,
} from '@medplum/core';
import type { Extension, HealthcareService, Practitioner, Schedule } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react-hooks';
import { act, fireEvent, render, screen } from '../test-utils/render';
import { ScheduleAvailabilityEditor } from './ScheduleAvailabilityEditor';
import {
  blankWeeklyAvailability,
  fromWeeklyAvailability,
  hasAnyAvailableDay,
  toWeeklyAvailability,
  validateWeeklyAvailability,
} from './ScheduleAvailabilityEditor.utils';

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

describe('ScheduleAvailabilityEditor utils', () => {
  test('toWeeklyAvailability pivots entries into per-day ranges', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['mon', 'wed'], availableStartTime: '09:00:00', availableEndTime: '12:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
      { daysOfWeek: ['sat'], allDay: true },
    ]);

    expect(weekly.mon.ranges).toEqual([
      { start: '09:00:00', end: '12:00:00' },
      { start: '13:00:00', end: '17:00:00' },
    ]);
    expect(weekly.wed).toEqual({ allDay: false, ranges: [{ start: '09:00:00', end: '12:00:00' }] });
    expect(weekly.sat).toEqual({ allDay: true, ranges: [] });
    expect(weekly.tue).toEqual({ allDay: false, ranges: [] });
  });

  test('toWeeklyAvailability skips entries missing a start or end time', () => {
    expect(toWeeklyAvailability([{ daysOfWeek: ['mon'], availableStartTime: '09:00:00' }])).toEqual(
      blankWeeklyAvailability()
    );
    expect(toWeeklyAvailability(undefined)).toEqual(blankWeeklyAvailability());
  });

  test('fromWeeklyAvailability emits one entry per range and round-trips', () => {
    const weekly = blankWeeklyAvailability();
    weekly.mon.ranges = [
      { start: '09:00:00', end: '12:00:00' },
      { start: '13:00:00', end: '17:00:00' },
    ];
    weekly.sat.allDay = true;
    // Ranges are ignored when allDay is set.
    weekly.sat.ranges = [{ start: '09:00:00', end: '12:00:00' }];

    expect(fromWeeklyAvailability(weekly)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '12:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
      { daysOfWeek: ['sat'], allDay: true },
    ]);
    expect(toWeeklyAvailability(fromWeeklyAvailability(weekly))).toEqual({
      ...weekly,
      sat: { allDay: true, ranges: [] },
    });
  });

  test('validateWeeklyAvailability rejects a missing or backwards range', () => {
    const backwards = blankWeeklyAvailability();
    backwards.mon.ranges = [{ start: '17:00:00', end: '09:00:00' }];
    expect(validateWeeklyAvailability(backwards).valid).toBe(false);
    expect(validateWeeklyAvailability(backwards).errors.mon).toBe('End time must be after start time');

    const missing = blankWeeklyAvailability();
    missing.mon.ranges = [{ start: '', end: '09:00:00' }];
    expect(validateWeeklyAvailability(missing).errors.mon).toBe('Start and end times are required');

    const ok = blankWeeklyAvailability();
    ok.wed.ranges = [{ start: '09:00:00', end: '17:00:00' }];
    expect(validateWeeklyAvailability(ok).valid).toBe(true);
  });

  test('validateWeeklyAvailability warns about overlaps without invalidating them', () => {
    const overlap = blankWeeklyAvailability();
    overlap.tue.ranges = [
      { start: '09:00:00', end: '13:00:00' },
      { start: '12:00:00', end: '15:00:00' },
    ];

    const validation = validateWeeklyAvailability(overlap);
    expect(validation.valid).toBe(true);
    expect(validation.errors.tue).toBeUndefined();
    expect(validation.warnings.tue).toBe('Time ranges overlap');
  });

  test('validateWeeklyAvailability treats allDay days as valid', () => {
    const weekly = blankWeeklyAvailability();
    weekly.mon.allDay = true;
    expect(validateWeeklyAvailability(weekly).valid).toBe(true);
  });

  test('hasAnyAvailableDay is false only when every day is unavailable', () => {
    expect(hasAnyAvailableDay(blankWeeklyAvailability())).toBe(false);

    const withRange = blankWeeklyAvailability();
    withRange.fri.ranges = [{ start: '09:00:00', end: '17:00:00' }];
    expect(hasAnyAvailableDay(withRange)).toBe(true);

    const withAllDay = blankWeeklyAvailability();
    withAllDay.sun.allDay = true;
    expect(hasAnyAvailableDay(withAllDay)).toBe(true);
  });
});

describe('ScheduleAvailabilityEditor component', () => {
  function setup(
    schedule: Schedule,
    onSave = vi.fn(),
    onCancel = vi.fn(),
    svc: HealthcareService = service
  ): { onSave: any; onCancel: any } {
    render(
      <MedplumProvider medplum={new MockClient()}>
        <ScheduleAvailabilityEditor schedule={schedule} service={svc} onCancel={onCancel} onSave={onSave} />
      </MedplumProvider>
    );
    return { onSave, onCancel };
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
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
    ]);
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
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['tue'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
    ]);
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
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '12:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
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
    expect(extractAvailability(updated, service)).toEqual([{ daysOfWeek: ['mon'], allDay: true }]);
  });

  test('Cancel does not call onSave', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave, onCancel } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  test('omits the Cancel button when no onCancel is given', () => {
    render(
      <MedplumProvider medplum={new MockClient()}>
        <ScheduleAvailabilityEditor
          schedule={scheduleWith(availableTime('mon', '09:00:00', '17:00:00'))}
          service={service}
          onSave={vi.fn()}
        />
      </MedplumProvider>
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
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

  test('overlapping ranges warn but still save', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '13:00:00'));
    const { onSave } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-add-mon'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-start-mon-1'), { target: { value: '12:00' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-end-mon-1'), { target: { value: '15:00' } });
    });

    expect(screen.getByTestId('schedule-availability-warning-mon')).toHaveTextContent('Time ranges overlap');
    expect(screen.queryByTestId('schedule-availability-error-mon')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);
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

  test('shows the timezone from the Schedule actor', async () => {
    const medplum = new MockClient();
    const practitioner = await medplum.createResource<Practitioner>({
      resourceType: 'Practitioner',
      extension: [{ url: TimezoneExtensionURI, valueCode: 'America/Los_Angeles' }],
    });
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    schedule.actor = [createReference(practitioner)];

    await act(async () => {
      render(
        <MedplumProvider medplum={medplum}>
          <ScheduleAvailabilityEditor schedule={schedule} service={service} onCancel={vi.fn()} onSave={vi.fn()} />
        </MedplumProvider>
      );
    });

    expect(screen.getByTestId('schedule-availability-timezone')).toHaveTextContent(
      'Hours are interpreted in the America/Los_Angeles timezone.'
    );
  });

  test('omits the timezone note when no timezone is configured', () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));
    expect(screen.queryByTestId('schedule-availability-timezone')).toBeNull();
  });

  test('disables Save when a custom override has no available days', async () => {
    const schedule = scheduleWith(availableTime('mon', '09:00:00', '17:00:00'));
    const { onSave } = setup(schedule);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-mon'));
    });

    expect(screen.getByTestId('schedule-availability-empty-override')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(onSave).not.toHaveBeenCalled();
  });
});
