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
  canAddRange,
  filterTimeOptions,
  formatMinutesOfDay,
  fromWeeklyAvailability,
  hasAnyAvailableDay,
  isOnTimeStep,
  MINUTES_PER_DAY,
  nearestOption,
  nextDayOfWeek,
  nextRange,
  timeOptions,
  toWeeklyAvailability,
} from './ScheduleAvailabilityEditor.utils';

const service: HealthcareService = {
  resourceType: 'HealthcareService',
  id: 'service-1',
  name: 'Follow-Up Visit',
};

// A service with native availableTime, used to exercise the inherited default path.
const serviceWithHours: HealthcareService = {
  resourceType: 'HealthcareService',
  id: 'service-1',
  name: 'Follow-Up Visit',
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
  test('toWeeklyAvailability pivots entries into per-day blocks', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['mon', 'wed'], availableStartTime: '09:00:00', availableEndTime: '12:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
      { daysOfWeek: ['sat'], allDay: true },
    ]);

    expect(weekly.mon).toEqual({
      enabled: true,
      ranges: [
        { start: 540, end: 720 },
        { start: 780, end: 1020 },
      ],
    });
    expect(weekly.wed).toEqual({ enabled: true, ranges: [{ start: 540, end: 720 }] });
    expect(weekly.sat).toEqual({ enabled: true, ranges: [{ start: 0, end: MINUTES_PER_DAY }] });
    expect(weekly.tue.enabled).toBe(false);
  });

  test('toWeeklyAvailability leaves a day off with default hours ready', () => {
    // Switching an unavailable day on should offer 9 to 5 rather than a blank row.
    expect(toWeeklyAvailability(undefined)).toEqual(blankWeeklyAvailability());
    expect(toWeeklyAvailability(undefined).tue).toEqual({ enabled: false, ranges: [{ start: 540, end: 1020 }] });
  });

  test('toWeeklyAvailability skips entries missing a start or end time', () => {
    expect(toWeeklyAvailability([{ daysOfWeek: ['mon'], availableStartTime: '09:00:00' }])).toEqual(
      blankWeeklyAvailability()
    );
    expect(toWeeklyAvailability([{ daysOfWeek: ['mon'], availableStartTime: 'not a time' }])).toEqual(
      blankWeeklyAvailability()
    );
  });

  test('toWeeklyAvailability splits a window running past midnight', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['fri'], availableStartTime: '22:00:00', availableEndTime: '06:00:00' },
    ]);

    expect(weekly.fri).toEqual({ enabled: true, ranges: [{ start: 1320, end: MINUTES_PER_DAY }] });
    expect(weekly.sat).toEqual({ enabled: true, ranges: [{ start: 0, end: 360 }] });
  });

  test('toWeeklyAvailability wraps a Sunday overnight window into Monday', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['sun'], availableStartTime: '20:00:00', availableEndTime: '02:00:00' },
    ]);

    expect(weekly.sun.ranges).toEqual([{ start: 1200, end: MINUTES_PER_DAY }]);
    expect(weekly.mon.ranges).toEqual([{ start: 0, end: 120 }]);
  });

  test('toWeeklyAvailability keeps a window ending exactly at midnight on one day', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['fri'], availableStartTime: '22:00:00', availableEndTime: '00:00:00' },
    ]);

    expect(weekly.fri.ranges).toEqual([{ start: 1320, end: MINUTES_PER_DAY }]);
    expect(weekly.sat.enabled).toBe(false);
  });

  test('toWeeklyAvailability reads a window ending at its start time as a full day', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '09:00:00' },
    ]);

    expect(weekly.mon).toEqual({ enabled: true, ranges: [{ start: 0, end: MINUTES_PER_DAY }] });
  });

  test('toWeeklyAvailability sorts and merges blocks the editor cannot show side by side', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '15:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '14:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '18:00:00', availableEndTime: '20:00:00' },
    ]);

    expect(weekly.mon.ranges).toEqual([
      { start: 540, end: 900 },
      { start: 1080, end: 1200 },
    ]);
  });

  test('toWeeklyAvailability rounds sub-minute precision', () => {
    const weekly = toWeeklyAvailability([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:30.500', availableEndTime: '17:00:00' },
    ]);

    expect(weekly.mon.ranges).toEqual([{ start: 541, end: 1020 }]);
  });

  test('fromWeeklyAvailability emits one entry per block and round-trips', () => {
    const weekly = blankWeeklyAvailability();
    weekly.mon = {
      enabled: true,
      ranges: [
        { start: 540, end: 720 },
        { start: 780, end: 1020 },
      ],
    };
    weekly.sat = { enabled: true, ranges: [{ start: 0, end: MINUTES_PER_DAY }] };
    // Hours on a day that is switched off are kept for later, not written out.
    weekly.sun = { enabled: false, ranges: [{ start: 540, end: 1020 }] };

    expect(fromWeeklyAvailability(weekly)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '12:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
      { daysOfWeek: ['sat'], allDay: true },
    ]);
    expect(toWeeklyAvailability(fromWeeklyAvailability(weekly))).toEqual(weekly);
  });

  test('fromWeeklyAvailability writes a block ending at midnight as midnight', () => {
    const weekly = blankWeeklyAvailability();
    weekly.fri = { enabled: true, ranges: [{ start: 1320, end: MINUTES_PER_DAY }] };

    expect(fromWeeklyAvailability(weekly)).toEqual([
      { daysOfWeek: ['fri'], availableStartTime: '22:00:00', availableEndTime: '00:00:00' },
    ]);
  });

  test('hasAnyAvailableDay is false only when every day is switched off', () => {
    expect(hasAnyAvailableDay(blankWeeklyAvailability())).toBe(false);

    const withHours = blankWeeklyAvailability();
    withHours.fri = { enabled: true, ranges: [{ start: 540, end: 1020 }] };
    expect(hasAnyAvailableDay(withHours)).toBe(true);
  });

  test('nextDayOfWeek advances and wraps at the end of the week', () => {
    expect(nextDayOfWeek('mon')).toBe('tue');
    expect(nextDayOfWeek('sat')).toBe('sun');
    expect(nextDayOfWeek('sun')).toBe('mon');
  });

  test('formatMinutesOfDay reads both midnights as 12:00 AM', () => {
    expect(formatMinutesOfDay(0)).toBe('12:00 AM');
    expect(formatMinutesOfDay(MINUTES_PER_DAY)).toBe('12:00 AM');
    expect(formatMinutesOfDay(540)).toBe('9:00 AM');
    expect(formatMinutesOfDay(725)).toBe('12:05 PM');
    expect(formatMinutesOfDay(1020)).toBe('5:00 PM');
  });

  test('timeOptions steps by five minutes between the bounds', () => {
    expect(timeOptions(540, 555)).toEqual([540, 545, 550, 555]);
    expect(timeOptions(0, MINUTES_PER_DAY)).toHaveLength(289);
    expect(timeOptions(1020, 1020)).toEqual([1020]);
  });

  test('timeOptions measures the interval from midnight, not from the bound', () => {
    // A bound off the interval narrows the list without shifting the times in
    // it, so a block stored as 9:07 still offers 9:10 rather than 9:12.
    expect(timeOptions(547, 570)).toEqual([550, 555, 560, 565, 570]);
    // Midnight stays reachable, which it would not be by stepping from 552.
    expect(timeOptions(552, MINUTES_PER_DAY)).toContain(MINUTES_PER_DAY);
  });

  test('isOnTimeStep marks the times the pickers can offer', () => {
    expect(isOnTimeStep(540)).toBe(true);
    expect(isOnTimeStep(547)).toBe(false);
  });

  test('nearestOption finds where an off-interval time sits in the list', () => {
    expect(nearestOption(timeOptions(0, MINUTES_PER_DAY), 547)).toBe(545);
    expect(nearestOption([], 547)).toBeUndefined();
  });

  test('filterTimeOptions returns everything when nothing is typed', () => {
    const options = timeOptions(0, MINUTES_PER_DAY);
    expect(filterTimeOptions(options, '', 540)).toBe(options);
    expect(filterTimeOptions(options, 'abc', 540)).toBe(options);
  });

  test('filterTimeOptions matches on the hour and leads with the nearest one', () => {
    const options = timeOptions(0, MINUTES_PER_DAY);

    // "9" is both 9 AM and 9 PM; the reading nearer the current value comes first.
    expect(filterTimeOptions(options, '9', 480)[0]).toBe(540);
    expect(filterTimeOptions(options, '9', 1300)[0]).toBe(1260);
    // Both readings are still reachable further down the list.
    expect(filterTimeOptions(options, '9', 480)).toContain(1260);
  });

  test('filterTimeOptions narrows as minutes are typed', () => {
    const options = timeOptions(0, MINUTES_PER_DAY);

    expect(filterTimeOptions(options, '930', 540).map(formatMinutesOfDay)).toEqual(['9:30 AM', '9:30 PM']);
    expect(filterTimeOptions(options, '9:30 pm', 540).map(formatMinutesOfDay)).toEqual(['9:30 PM']);
    expect(filterTimeOptions(options, '930a', 540).map(formatMinutesOfDay)).toEqual(['9:30 AM']);
  });

  test('filterTimeOptions reads a leading 1 as both an hour and a prefix', () => {
    const formatted = filterTimeOptions(timeOptions(0, MINUTES_PER_DAY), '12', 0).map(formatMinutesOfDay);

    // 12 o'clock is the more complete reading, so it leads; 1:2x follows.
    expect(formatted[0]).toBe('12:00 AM');
    expect(formatted).toContain('1:20 AM');
  });

  test('filterTimeOptions stays within the offered options', () => {
    // Afternoon only, so a morning match has nothing to return.
    expect(filterTimeOptions(timeOptions(780, MINUTES_PER_DAY), '9a', 780)).toEqual([]);
  });

  test('canAddRange is false once a day runs to midnight', () => {
    expect(canAddRange([{ start: 540, end: 1020 }])).toBe(true);
    expect(canAddRange([{ start: 540, end: MINUTES_PER_DAY }])).toBe(false);
    expect(canAddRange([])).toBe(false);
  });

  test('nextRange opens an hour after the previous block and clamps to midnight', () => {
    expect(nextRange([{ start: 540, end: 720 }])).toEqual({ start: 780, end: 840 });
    expect(nextRange([{ start: 540, end: MINUTES_PER_DAY - 10 }])).toEqual({
      start: MINUTES_PER_DAY - 5,
      end: MINUTES_PER_DAY,
    });
  });

  test('nextRange lands on the interval even after a block that does not', () => {
    // 12:07 PM plus an hour is 1:07 PM, which the pickers cannot offer.
    expect(nextRange([{ start: 540, end: 727 }])).toEqual({ start: 790, end: 850 });
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

  function save(): Promise<void> {
    return act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    });
  }

  // Opens a time picker and chooses the option with the given display text.
  async function pickTime(testId: string, option: string): Promise<void> {
    await act(async () => {
      fireEvent.focus(screen.getByTestId(testId));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(option));
    });
  }

  // Types into a time picker and tabs away without picking from the list.
  async function typeTimeAndLeave(testId: string, text: string): Promise<void> {
    const input = screen.getByTestId(testId);
    await act(async () => {
      fireEvent.focus(input);
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: text } });
    });
    await act(async () => {
      fireEvent.blur(input);
    });
  }

  test('renders existing availability and saves an updated Schedule', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('9:00 AM');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('5:00 PM');

    await save();

    expect(onSave).toHaveBeenCalledTimes(1);
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
    ]);
  });

  test('lists the days starting on Sunday', () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    const days = screen.getAllByRole('switch').map((el) => el.getAttribute('aria-label'));
    expect(days).toEqual([
      'Enable custom availability for Follow-Up Visit',
      'Available on Sunday',
      'Available on Monday',
      'Available on Tuesday',
      'Available on Wednesday',
      'Available on Thursday',
      'Available on Friday',
      'Available on Saturday',
    ]);
  });

  test('toggling a day on adds default hours and saves them', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    expect(screen.queryByTestId('schedule-availability-start-tue-0')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-tue'));
    });
    expect(screen.getByTestId('schedule-availability-start-tue-0')).toHaveValue('9:00 AM');

    await save();

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
      { daysOfWeek: ['tue'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
    ]);
  });

  test('toggling a day off keeps its hours for when it comes back on', async () => {
    setup(scheduleWith(availableTime('mon', '10:00:00', '14:00:00')));

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-mon'));
    });
    expect(screen.queryByTestId('schedule-availability-start-mon-0')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-mon'));
    });
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('10:00 AM');
  });

  test('supports adding and removing blocks of hours in a day', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-add-mon'));
    });
    // A new block opens an hour after the previous one ends.
    expect(screen.getByTestId('schedule-availability-start-mon-1')).toHaveValue('1:00 PM');
    expect(screen.getByTestId('schedule-availability-end-mon-1')).toHaveValue('2:00 PM');

    await pickTime('schedule-availability-end-mon-1', '5:00 PM');
    await save();

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '12:00:00' },
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
    ]);
  });

  test('removes a block of hours', async () => {
    const { onSave } = setup(
      scheduleWith(availableTime('mon', '09:00:00', '12:00:00'), availableTime('mon', '13:00:00', '17:00:00'))
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-remove-mon-0'));
    });

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('1:00 PM');
    expect(screen.queryByTestId('schedule-availability-start-mon-1')).toBeNull();
    // The remove button goes away once a single block is left.
    expect(screen.queryByTestId('schedule-availability-remove-mon-0')).toBeNull();

    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '13:00:00', availableEndTime: '17:00:00' },
    ]);
  });

  test('offers only the hours left after the previous block', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00'), availableTime('mon', '13:00:00', '17:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-start-mon-1'));
    });

    // The second block cannot start before the first one ends.
    expect(screen.queryByText('11:00 AM')).toBeNull();
    expect(screen.getByText('12:00 PM')).toBeDefined();
  });

  test('offers times up to midnight on the last block', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-end-mon-0'));
    });

    expect(screen.getByText('11:55 PM')).toBeDefined();
    expect(screen.getByText('12:00 AM')).toBeDefined();
  });

  test('an end time cannot be set before its start time', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-end-mon-0'));
    });

    // Overnight windows are no longer authorable, so nothing earlier than the
    // start time is on offer.
    expect(screen.queryByText('8:00 AM')).toBeNull();
    expect(screen.getByText('9:05 AM')).toBeDefined();
  });

  test('a start can be set past its own end, moving the end an hour out', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    await pickTime('schedule-availability-start-mon-0', '2:00 PM');

    // The new start is accepted rather than refused, and the end follows it by
    // an hour regardless of how long the block was before.
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('2:00 PM');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('3:00 PM');

    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '14:00:00', availableEndTime: '15:00:00' },
    ]);
  });

  test('a start moved late in the day stops the end at midnight', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    await pickTime('schedule-availability-start-mon-0', '11:55 PM');

    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('12:00 AM');
  });

  test('a start moved earlier leaves the end where it is', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    await pickTime('schedule-availability-start-mon-0', '8:00 AM');

    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('12:00 PM');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).not.toHaveAttribute('data-flashing');
  });

  test('flashes the end time when the editor moves it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

      await pickTime('schedule-availability-start-mon-0', '2:00 PM');
      expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveAttribute('data-flashing');

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('schedule-availability-end-mon-0')).not.toHaveAttribute('data-flashing');
    } finally {
      vi.useRealTimers();
    }
  });

  test('announces an end time the editor moves', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    const announcement = screen.getByTestId('schedule-availability-announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toBeEmptyDOMElement();

    await pickTime('schedule-availability-start-mon-0', '2:00 PM');

    // The flash is only visible, so the same change is spoken.
    expect(announcement).toHaveTextContent('Monday block 1 end time changed to 3:00 PM.');
  });

  test('says nothing when the end time was not moved', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    await pickTime('schedule-availability-start-mon-0', '8:00 AM');

    expect(screen.getByTestId('schedule-availability-announcement')).toBeEmptyDOMElement();
  });

  test('a start may be picked past the end, up to 11:55 PM', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '12:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-start-mon-0'));
    });

    // Not capped at the current end time of 12:00 PM.
    expect(screen.getByText('6:00 PM')).toBeDefined();
    expect(screen.getByText('11:55 PM')).toBeDefined();
  });

  test('typing filters the times on offer', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-start-mon-0'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-start-mon-0'), { target: { value: '730a' } });
    });

    expect(screen.getByText('7:30 AM')).toBeDefined();
    expect(screen.queryByText('9:00 AM')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('7:30 AM'));
    });
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('7:30 AM');
  });

  test('takes a typed time when the field is tabbed out of', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await typeTimeAndLeave('schedule-availability-end-mon-0', '630p');

    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('6:30 PM');

    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '18:30:00' },
    ]);
  });

  test('leaves the time alone when nothing was typed, or nothing matched', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    // Focused and left without typing.
    await typeTimeAndLeave('schedule-availability-end-mon-0', '');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('5:00 PM');

    // Typed something no time can match.
    await typeTimeAndLeave('schedule-availability-end-mon-0', '99');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('5:00 PM');
  });

  test('a typed time outside the bounds of its row is not taken', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    // 8 AM is before this block starts, so it is not among the times on offer
    // and tabbing away leaves the end time as it was. Taking a typed time can
    // never put a row outside its bounds, so no error state is needed.
    await typeTimeAndLeave('schedule-availability-end-mon-0', '8a');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('5:00 PM');
  });

  test('picking from the list changes the time exactly once', async () => {
    const onChange = vi.fn();
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')), onChange);

    // Typing then clicking an option must not also commit on the blur that
    // follows the click.
    const input = screen.getByTestId('schedule-availability-end-mon-0');
    await act(async () => {
      fireEvent.focus(input);
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: '630p' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('6:30 PM'));
    });

    expect(input).toHaveValue('6:30 PM');
    await save();
    expect(extractAvailability(onChange.mock.calls[0][0], service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:00:00', availableEndTime: '18:30:00' },
    ]);
  });

  test('says so when a typed time matches nothing', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-end-mon-0'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('schedule-availability-end-mon-0'), { target: { value: '8a' } });
    });

    expect(screen.getByText('No matching time')).toBeDefined();
  });

  test('saves a full day as the allDay flag', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await pickTime('schedule-availability-start-mon-0', '12:00 AM');
    await pickTime('schedule-availability-end-mon-0', '12:00 AM');
    await save();

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([{ daysOfWeek: ['mon'], allDay: true }]);
  });

  test('reads stored allDay hours back as a full day', () => {
    const schedule = scheduleWith({
      url: 'availableTime',
      extension: [
        { url: 'daysOfWeek', valueCode: 'mon' },
        { url: 'allDay', valueBoolean: true },
      ],
    });
    setup(schedule);

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('12:00 AM');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('12:00 AM');
  });

  test('splits stored overnight hours across the two days', async () => {
    const { onSave } = setup(scheduleWith(availableTime('fri', '22:00:00', '06:00:00')));

    expect(screen.getByTestId('schedule-availability-start-fri-0')).toHaveValue('10:00 PM');
    expect(screen.getByTestId('schedule-availability-end-fri-0')).toHaveValue('12:00 AM');
    expect(screen.getByTestId('schedule-availability-start-sat-0')).toHaveValue('12:00 AM');
    expect(screen.getByTestId('schedule-availability-end-sat-0')).toHaveValue('6:00 AM');

    // Saving without edits keeps the same bookable hours, in the split form.
    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['fri'], availableStartTime: '22:00:00', availableEndTime: '00:00:00' },
      { daysOfWeek: ['sat'], availableStartTime: '00:00:00', availableEndTime: '06:00:00' },
    ]);
  });

  test('shows a stored time that is off the picker interval, marked as such', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:07:00', '17:00:00')));

    // Shown as stored rather than rounded to something nobody asked for.
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('9:07 AM');
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveAttribute('data-off-step');
    expect(screen.getByTestId('schedule-availability-start-mon-0-off-step')).toBeInTheDocument();

    // The end sits on the interval, so it is not marked.
    expect(screen.getByTestId('schedule-availability-end-mon-0')).toHaveValue('5:00 PM');
    expect(screen.getByTestId('schedule-availability-end-mon-0')).not.toHaveAttribute('data-off-step');

    // Saving without touching it keeps the stored time.
    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:07:00', availableEndTime: '17:00:00' },
    ]);
  });

  test('an off-interval time does not shift the times on offer', async () => {
    setup(scheduleWith(availableTime('mon', '09:07:00', '17:00:00')));

    await act(async () => {
      fireEvent.focus(screen.getByTestId('schedule-availability-end-mon-0'));
    });

    // Measured from midnight, not from 9:07, and midnight is still reachable.
    expect(screen.getByText('9:10 AM')).toBeDefined();
    expect(screen.queryByText('9:12 AM')).toBeNull();
    expect(screen.getByText('12:00 AM')).toBeDefined();
  });

  test('editing an off-interval time replaces it with one on the interval', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:07:00', '17:00:00')));

    await pickTime('schedule-availability-start-mon-0', '9:10 AM');

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('9:10 AM');
    expect(screen.getByTestId('schedule-availability-start-mon-0')).not.toHaveAttribute('data-off-step');

    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(extractAvailability(updated, service)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '09:10:00', availableEndTime: '17:00:00' },
    ]);
  });

  test('Cancel does not call onSave', async () => {
    const { onSave, onCancel } = setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

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

  test('seeds from the service default with the override switch off', () => {
    setup(scheduleWithoutOverride(), vi.fn(), vi.fn(), serviceWithHours);

    expect(screen.getByTestId('schedule-availability-enable')).not.toBeChecked();
    // Monday is seeded from the service default hours, but is not editable.
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('8:00 AM');
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toBeDisabled();
    expect(screen.getByTestId('schedule-availability-switch-wed')).toBeDisabled();
    expect(screen.getByTestId('schedule-availability-reset')).toBeDisabled();
  });

  test('saving while inheriting clears any override', async () => {
    const { onSave } = setup(scheduleWithoutOverride(), vi.fn(), vi.fn(), serviceWithHours);

    await save();

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(false);
  });

  test('switching custom availability on creates an override', async () => {
    const { onSave } = setup(scheduleWithoutOverride(), vi.fn(), vi.fn(), serviceWithHours);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-enable'));
    });
    expect(screen.getByTestId('schedule-availability-switch-wed')).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-wed'));
    });
    await save();

    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(true);
    expect(extractAvailability(updated, serviceWithHours)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '08:00:00', availableEndTime: '16:00:00' },
      { daysOfWeek: ['tue'], availableStartTime: '08:00:00', availableEndTime: '16:00:00' },
      { daysOfWeek: ['wed'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
      { daysOfWeek: ['sat'], allDay: true },
    ]);
  });

  test('switching custom availability off discards the override and shows the default', async () => {
    const { onSave } = setup(
      scheduleWith(availableTime('mon', '09:00:00', '17:00:00')),
      vi.fn(),
      vi.fn(),
      serviceWithHours
    );

    expect(screen.getByTestId('schedule-availability-enable')).toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-enable'));
    });

    // The greyed out hours are the service default that is now back in effect.
    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('8:00 AM');

    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(false);
  });

  test('reset restores the service default hours while staying an override', async () => {
    const { onSave } = setup(
      scheduleWith(availableTime('mon', '09:00:00', '17:00:00')),
      vi.fn(),
      vi.fn(),
      serviceWithHours
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-reset'));
    });

    expect(screen.getByTestId('schedule-availability-start-mon-0')).toHaveValue('8:00 AM');
    expect(screen.getByTestId('schedule-availability-enable')).toBeChecked();

    await save();
    const updated: Schedule = onSave.mock.calls[0][0];
    expect(hasAvailabilityOverride(updated, serviceWithHours)).toBe(true);
    // The same hours as the service default, written out one day at a time.
    expect(extractAvailability(updated, serviceWithHours)).toEqual([
      { daysOfWeek: ['mon'], availableStartTime: '08:00:00', availableEndTime: '16:00:00' },
      { daysOfWeek: ['tue'], availableStartTime: '08:00:00', availableEndTime: '16:00:00' },
      { daysOfWeek: ['sat'], allDay: true },
    ]);
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
      'All times are in local America/Los_Angeles time zone.'
    );
  });

  test('omits the timezone note when no timezone is configured', () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));
    expect(screen.queryByTestId('schedule-availability-timezone')).toBeNull();
  });

  test('refuses to save a custom override with no available days', async () => {
    const { onSave } = setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-mon'));
    });

    const saveButton = screen.getByRole('button', { name: 'Save Settings' });
    expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    expect(saveButton).toHaveAttribute('data-disabled');

    await save();
    expect(onSave).not.toHaveBeenCalled();
  });

  test('gives the reason on the Save button rather than in the form', async () => {
    setup(scheduleWith(availableTime('mon', '09:00:00', '17:00:00')));

    // Nothing to explain while the day is available.
    expect(screen.queryByTestId('schedule-availability-empty-override')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-mon'));
    });

    // The reason reaches the pointer through a tooltip on hover, and assistive
    // technology through the button's description, rather than as a message in
    // the body of the form.
    const reason = screen.getByTestId('schedule-availability-empty-override');
    expect(reason).toHaveTextContent(
      'Custom availability must include at least one available day. ' +
        'To stop scheduling Follow-Up Visit on this calendar, turn it off in schedule settings.'
    );
    expect(screen.getByRole('button', { name: 'Save Settings' })).toHaveAttribute(
      'aria-describedby',
      reason.getAttribute('id')
    );

    // The button stays focusable precisely so the reason is reachable without
    // a pointer.
    await act(async () => {
      fireEvent.focus(screen.getByRole('button', { name: 'Save Settings' }));
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('must include at least one available day');

    // Making a day available again clears all of it.
    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-availability-switch-mon'));
    });
    expect(screen.queryByTestId('schedule-availability-empty-override')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Settings' })).not.toHaveAttribute('aria-disabled');
  });
});
