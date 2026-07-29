// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Divider,
  Group,
  Paper,
  Stack,
  Switch,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import type { DayOfWeek } from '@medplum/core';
import {
  applyAvailability,
  clearAvailabilityOverride,
  extractAvailability,
  getSchedulingTimezone,
  hasAvailabilityOverride,
} from '@medplum/core';
import type { HealthcareService, Schedule } from '@medplum/fhirtypes';
import { useResource } from '@medplum/react-hooks';
import { IconMinus, IconPlus } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useId, useState } from 'react';
import type { DayAvailability, WeeklyAvailability } from './ScheduleAvailabilityEditor.utils';
import {
  canAddRange,
  DAY_DISPLAY_ORDER,
  DAY_LABELS,
  DEFAULT_RANGE,
  formatMinutesOfDay,
  fromWeeklyAvailability,
  hasAnyAvailableDay,
  MINUTES_PER_DAY,
  nextRange,
  toWeeklyAvailability,
} from './ScheduleAvailabilityEditor.utils';
import { TimeSelect } from './TimeSelect';

// Width of the day name column, so every row's hours start on the same edge.
const DAY_COLUMN_WIDTH = 168;
// A single row's height, used to keep a day with no hours the same height as one
// with a block of them.
const ROW_HEIGHT = 36;
// Width of an action slot. Reserved whether or not it holds a button, so the
// rows above and below stay aligned.
const ACTION_WIDTH = 28;

// A disabled Switch greys out its track, which reads as "off" rather than "not
// editable". Days keep their colour while the whole editor is switched off.
const DISABLED_ON_SWITCH_STYLES = {
  track: { backgroundColor: 'var(--mantine-color-green-6)', borderColor: 'transparent' },
};

interface DayRowProps {
  readonly day: DayOfWeek;
  readonly value: DayAvailability;
  readonly disabled: boolean;
  readonly onChange: (value: DayAvailability) => void;
  readonly onAnnounce: (message: string) => void;
}

function DayRow(props: DayRowProps): JSX.Element {
  const { day, value, disabled, onChange, onAnnounce } = props;
  const { enabled, ranges } = value;
  const label = DAY_LABELS[day];
  // Identifies the end input to flash, and changes on every move so that
  // repeated moves each get their own flash.
  const [movedEnd, setMovedEnd] = useState<{ index: number; key: number }>();

  // Each block is bounded by its neighbours, so the times on offer are only ever
  // the ones still free that day. The last block may run to midnight.
  function boundsAfter(index: number): number {
    return index === ranges.length - 1 ? MINUTES_PER_DAY : ranges[index + 1].start;
  }

  // A start may be set anywhere still free that day, even past its own end, so
  // that a later block can be opened without editing it twice. When that
  // happens the end moves an hour out from the new start. The move is flashed
  // for anyone watching and announced for anyone not.
  function setStart(index: number, start: number): void {
    const range = ranges[index];
    const end = start >= range.end ? Math.min(start + 60, boundsAfter(index)) : range.end;
    if (end !== range.end) {
      setMovedEnd((previous) => ({ index, key: (previous?.key ?? 0) + 1 }));
      onAnnounce(`${label} block ${index + 1} end time changed to ${formatMinutesOfDay(end)}.`);
    }
    onChange({ ...value, ranges: ranges.with(index, { start, end }) });
  }

  function setEnd(index: number, end: number): void {
    onChange({ ...value, ranges: ranges.with(index, { ...ranges[index], end }) });
  }

  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      <Group gap="sm" wrap="nowrap" w={DAY_COLUMN_WIDTH} h={ROW_HEIGHT} style={{ flexShrink: 0 }}>
        <Switch
          checked={enabled}
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            onChange({
              enabled: checked,
              ranges: checked && ranges.length === 0 ? [{ ...DEFAULT_RANGE }] : ranges,
            });
          }}
          color="green.6"
          withThumbIndicator={false}
          disabled={disabled}
          styles={disabled && enabled ? DISABLED_ON_SWITCH_STYLES : undefined}
          aria-label={`Available on ${label}`}
          data-testid={`schedule-availability-switch-${day}`}
        />
        <Text fw={500}>{label}</Text>
      </Group>
      {enabled ? (
        <Stack gap="xs">
          {ranges.map((range, index) => {
            const last = index === ranges.length - 1;
            const canAdd = canAddRange(ranges);
            return (
              // Blocks are kept sorted and non-overlapping, so a row's position
              // in the day is a stable enough identity for it.
              <Group key={index} gap="xs" wrap="nowrap">
                <TimeSelect
                  value={range.start}
                  min={index === 0 ? 0 : ranges[index - 1].end}
                  // Bounds are exclusive by a minute rather than by a whole
                  // step, so a neighbour stored off the interval still leaves
                  // the usual times on offer here.
                  max={boundsAfter(index) - 1}
                  onChange={(start) => setStart(index, start)}
                  disabled={disabled}
                  label={`${label} block ${index + 1} start time`}
                  testId={`schedule-availability-start-${day}-${index}`}
                />
                <Text c="dimmed" px={4}>
                  to
                </Text>
                <TimeSelect
                  value={range.end}
                  min={range.start + 1}
                  max={boundsAfter(index)}
                  onChange={(end) => setEnd(index, end)}
                  disabled={disabled}
                  label={`${label} block ${index + 1} end time`}
                  testId={`schedule-availability-end-${day}-${index}`}
                  flashKey={movedEnd?.index === index ? movedEnd.key : undefined}
                />
                <Box w={ACTION_WIDTH} style={{ flexShrink: 0 }}>
                  {last && (
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      radius="xl"
                      onClick={() => onChange({ ...value, ranges: [...ranges, nextRange(ranges)] })}
                      disabled={disabled || !canAdd}
                      aria-label={`Add another block of hours on ${label}`}
                      data-testid={`schedule-availability-add-${day}`}
                    >
                      <IconPlus size={16} stroke={1.8} />
                    </ActionIcon>
                  )}
                </Box>
                <Box w={ACTION_WIDTH} style={{ flexShrink: 0 }}>
                  {ranges.length > 1 && (
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      radius="xl"
                      onClick={() => onChange({ ...value, ranges: ranges.toSpliced(index, 1) })}
                      disabled={disabled}
                      aria-label={`Remove ${label} block ${index + 1}`}
                      data-testid={`schedule-availability-remove-${day}-${index}`}
                    >
                      <IconMinus size={16} stroke={1.8} />
                    </ActionIcon>
                  )}
                </Box>
              </Group>
            );
          })}
        </Stack>
      ) : (
        <Text c="dimmed" h={ROW_HEIGHT} lh={`${ROW_HEIGHT}px`}>
          Unavailable
        </Text>
      )}
    </Group>
  );
}

/**
 * Props for the ScheduleAvailabilityEditor component.
 * @param schedule - The Schedule holding the availability override. Must have exactly one actor, as scheduling requires.
 * @param service - The HealthcareService whose availability is being edited.
 * @param onSave - Called with the updated Schedule when the user saves. The caller performs the write, and may return a
 * Promise to keep the save button in its pending state until the write settles.
 * @param onCancel - Called when the user cancels. Omit to hide the cancel button, e.g. when the editor is inline on a page.
 */
export interface ScheduleAvailabilityEditorProps {
  readonly schedule: Schedule;
  readonly service: HealthcareService;
  readonly onSave: (updatedSchedule: Schedule) => void | Promise<void>;
  readonly onCancel?: () => void;
}

/**
 * Edits the weekly availability a Schedule uses for one visit service type.
 *
 * This renders form content only. The caller supplies the container, so the
 * editor can live inline in a page, in a Modal, or in a Drawer.
 * @param props - Schedule, service, and save/cancel handlers
 * @returns The availability editor form
 */
export function ScheduleAvailabilityEditor(props: ScheduleAvailabilityEditorProps): JSX.Element {
  const { schedule, service, onSave, onCancel } = props;
  // Seed from the Schedule override when it has one, otherwise from the
  // service-level default, so the editor opens showing the hours currently in
  // effect rather than a blank week.
  const [overriding, setOverriding] = useState(() => hasAvailabilityOverride(schedule, service));
  const [weekly, setWeekly] = useState<WeeklyAvailability>(() =>
    toWeeklyAvailability(extractAvailability(schedule, service))
  );
  const [saving, setSaving] = useState(false);
  // The flash on an auto-moved end time is only visible, so the same change is
  // also announced.
  const [announcement, setAnnouncement] = useState('');
  const reasonId = useId();

  // Scheduling falls back to the actor's timezone extension when neither the
  // Schedule nor the service parameters specify one, which is the most common
  // setup, so the actor has to be loaded to resolve the timezone the same way
  // the server does. Scheduling requires exactly one actor per Schedule.
  const actor = useResource(schedule.actor[0]);
  const timezone = getSchedulingTimezone(schedule, service, actor);
  const serviceName = service.name ?? 'this visit service type';

  // An override with zero available days serializes to `{ url: 'availability',
  // extension: [] }`, which fails FHIR constraint ext-1 on write. Require at
  // least one available day for custom hours; to disable a service on this
  // calendar, toggle it off in schedule settings instead.
  const emptyOverride = overriding && !hasAnyAvailableDay(weekly);
  const emptyOverrideReason =
    `Custom availability must include at least one available day. ` +
    `To stop scheduling ${serviceName} on this calendar, turn it off in schedule settings.`;

  // Switching the override off puts the service default back in effect, so the
  // greyed out hours show that default rather than edits that no longer apply.
  function toggleOverriding(next: boolean): void {
    setOverriding(next);
    if (!next) {
      setWeekly(toWeeklyAvailability(service.availableTime));
    }
  }

  async function handleSave(): Promise<void> {
    if (emptyOverride) {
      return;
    }
    setSaving(true);
    try {
      const updated = overriding
        ? applyAvailability(schedule, service, fromWeeklyAvailability(weekly))
        : clearAvailabilityOverride(schedule, service);
      await onSave(updated);
    } finally {
      setSaving(false);
    }
  }

  // A `disabled` button emits no pointer events and drops out of the tab order,
  // which would leave the reason it is disabled out of reach in a tooltip.
  // Marking it disabled without the attribute keeps it hoverable and focusable:
  // `aria-disabled` carries the state, the description carries the reason for
  // anyone who cannot see the tooltip, and `handleSave` already refuses to run.
  const saveButton = (
    <Tooltip
      label={emptyOverrideReason}
      disabled={!emptyOverride}
      multiline
      w={300}
      withArrow
      position="top"
      // Reaching the button by keyboard should explain it too, not just hovering.
      events={{ hover: true, focus: true, touch: true }}
    >
      <Button
        onClick={handleSave}
        loading={saving}
        fullWidth={!onCancel}
        data-disabled={emptyOverride || undefined}
        aria-disabled={emptyOverride || undefined}
        aria-describedby={emptyOverride ? reasonId : undefined}
      >
        Save Settings
      </Button>
    </Tooltip>
  );

  return (
    <Stack gap="lg">
      <Text c="dimmed">
        Customize your weekly working hours to override the general availability for {serviceName}.
      </Text>
      <Paper withBorder radius="md" p="xl">
        <Group gap="sm" wrap="nowrap" h={ROW_HEIGHT}>
          <Switch
            checked={overriding}
            onChange={(e) => toggleOverriding(e.currentTarget.checked)}
            color="green.6"
            withThumbIndicator={false}
            aria-label={`Enable custom availability for ${serviceName}`}
            data-testid="schedule-availability-enable"
          />
          <Text fw={500}>Enable custom availability for {serviceName}</Text>
        </Group>
        <Divider my="lg" />
        <Stack gap="md" opacity={overriding ? 1 : 0.8}>
          {DAY_DISPLAY_ORDER.map((day) => (
            <DayRow
              key={day}
              day={day}
              value={weekly[day]}
              disabled={!overriding}
              onChange={(value) => setWeekly((prev) => ({ ...prev, [day]: value }))}
              onAnnounce={setAnnouncement}
            />
          ))}
        </Stack>
        <VisuallyHidden role="status" aria-live="polite" data-testid="schedule-availability-announcement">
          {announcement}
        </VisuallyHidden>
        <Stack gap="sm" mt="xl">
          <Group justify="flex-start">
            <Anchor
              component="button"
              type="button"
              onClick={() => setWeekly(toWeeklyAvailability(service.availableTime))}
              disabled={!overriding}
              c={overriding ? undefined : 'dimmed'}
              underline={overriding ? 'hover' : 'never'}
              data-testid="schedule-availability-reset"
            >
              Reset to default availability of {serviceName}
            </Anchor>
          </Group>
          {timezone && (
            <Text c="dimmed" data-testid="schedule-availability-timezone">
              All times are in local {timezone} time zone.
            </Text>
          )}
        </Stack>
      </Paper>
      {emptyOverride && (
        <VisuallyHidden id={reasonId} data-testid="schedule-availability-empty-override">
          {emptyOverrideReason}
        </VisuallyHidden>
      )}
      {onCancel ? (
        <Group grow>
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          {saveButton}
        </Group>
      ) : (
        saveButton
      )}
    </Stack>
  );
}
