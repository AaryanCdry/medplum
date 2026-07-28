// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import type { DayOfWeek } from '@medplum/core';
import {
  applyAvailability,
  clearAvailabilityOverride,
  DAYS_OF_WEEK,
  extractAvailability,
  getSchedulingTimezone,
  hasAvailabilityOverride,
} from '@medplum/core';
import type { HealthcareService, Schedule } from '@medplum/fhirtypes';
import { useResource } from '@medplum/react-hooks';
import type { JSX } from 'react';
import { useState } from 'react';
import { ArrayAddButton } from '../buttons/ArrayAddButton';
import { ArrayRemoveButton } from '../buttons/ArrayRemoveButton';
import type { TimeRange, WeeklyAvailability } from './ScheduleAvailabilityEditor.utils';
import {
  DAY_LABELS,
  fromWeeklyAvailability,
  hasAnyAvailableDay,
  toWeeklyAvailability,
  validateWeeklyAvailability,
} from './ScheduleAvailabilityEditor.utils';

const DEFAULT_RANGE: TimeRange = { start: '09:00:00', end: '17:00:00' };

// A cleared `type="time"` input reports an empty string. Keep it empty rather
// than appending seconds, so validation reports the time as missing instead of
// treating a malformed ":00" as a real value.
function toTimeOfDay(value: string): string {
  return value ? `${value}:00` : '';
}

// Internal draft entry, adding a stable id so range rows keep their identity as
// they are added/removed.
interface DraftRange extends TimeRange {
  readonly id: number;
}

interface DayDraft {
  allDay: boolean;
  ranges: DraftRange[];
}

type DraftAvailability = Record<DayOfWeek, DayDraft>;

export interface ScheduleAvailabilityEditorProps {
  readonly schedule: Schedule;
  /** The service whose availability is being edited. */
  readonly service: HealthcareService;
  readonly onSave: (updatedSchedule: Schedule) => void | Promise<void>;
  readonly onCancel?: () => void;
}

function toDraft(weekly: WeeklyAvailability): DraftAvailability {
  const draft = {} as DraftAvailability;
  let id = 0;
  for (const day of DAYS_OF_WEEK) {
    draft[day] = {
      allDay: weekly[day].allDay,
      ranges: weekly[day].ranges.map((range) => ({ ...range, id: id++ })),
    };
  }
  return draft;
}

// Row keys only have to be unique among the rows currently rendered, so deriving
// the next one from the draft avoids threading a mutable counter through render.
function nextRangeId(draft: DraftAvailability): number {
  let max = -1;
  for (const day of DAYS_OF_WEEK) {
    for (const range of draft[day].ranges) {
      max = Math.max(max, range.id);
    }
  }
  return max + 1;
}

function toWeekly(draft: DraftAvailability): WeeklyAvailability {
  const weekly = {} as WeeklyAvailability;
  for (const day of DAYS_OF_WEEK) {
    weekly[day] = {
      allDay: draft[day].allDay,
      ranges: draft[day].ranges.map((range) => ({ start: range.start, end: range.end })),
    };
  }
  return weekly;
}

/**
 * Edits the weekly availability a Schedule uses for one HealthcareService.
 *
 * This renders form content only. The caller supplies the container, so the
 * editor can live inline in a page, in a Drawer, or in a Modal. When the
 * container has a constrained height, the day list scrolls and the action bar
 * stays pinned to the bottom.
 * @param props - Schedule, service, and save/cancel handlers
 * @returns The availability editor form
 */
export function ScheduleAvailabilityEditor(props: ScheduleAvailabilityEditorProps): JSX.Element {
  const { schedule, service, onSave, onCancel } = props;
  // Seed from the Schedule override when it has one, otherwise from the
  // service-level default, so the editor opens showing the hours currently in
  // effect rather than a blank week.
  const [overriding, setOverriding] = useState(() => hasAvailabilityOverride(schedule, service));
  const [draft, setDraft] = useState<DraftAvailability>(() =>
    toDraft(toWeeklyAvailability(extractAvailability(schedule, service)))
  );
  const [saving, setSaving] = useState(false);

  // Scheduling falls back to the actor's timezone extension when neither the
  // Schedule nor the service parameters specify one, which is the most common
  // setup, so the actor has to be loaded to resolve the timezone the same way
  // the server does. Scheduling requires exactly one actor per Schedule.
  const actor = useResource(schedule.actor[0]);
  const timezone = getSchedulingTimezone(schedule, service, actor);
  const weekly = toWeekly(draft);
  const validation = validateWeeklyAvailability(weekly);
  // An override with zero available days serializes to `{ url: 'availability',
  // extension: [] }`, which fails FHIR constraint ext-1 on write. Require at
  // least one available day for custom hours; to disable a service on this
  // calendar, toggle it off in schedule settings instead.
  const emptyOverride = overriding && !hasAnyAvailableDay(weekly);
  const canSave = validation.valid && !emptyOverride;

  // Any manual edit diverges from the service default, so mark the draft as an override.
  function setDay(day: DayOfWeek, value: DayDraft): void {
    setOverriding(true);
    setDraft((prev) => ({ ...prev, [day]: value }));
  }

  // Discard the override and restore the inherited service-default hours.
  function resetToServiceDefault(): void {
    setDraft(toDraft(toWeeklyAvailability(service.availableTime)));
    setOverriding(false);
  }

  function toggleDay(day: DayOfWeek, available: boolean): void {
    if (available) {
      setDay(day, { allDay: false, ranges: [{ ...DEFAULT_RANGE, id: nextRangeId(draft) }] });
    } else {
      setDay(day, { allDay: false, ranges: [] });
    }
  }

  function toggleAllDay(day: DayOfWeek, allDay: boolean): void {
    if (allDay) {
      setDay(day, { allDay: true, ranges: [] });
    } else {
      setDay(day, { allDay: false, ranges: [{ ...DEFAULT_RANGE, id: nextRangeId(draft) }] });
    }
  }

  function addRange(day: DayOfWeek): void {
    setDay(day, { ...draft[day], ranges: [...draft[day].ranges, { ...DEFAULT_RANGE, id: nextRangeId(draft) }] });
  }

  function removeRange(day: DayOfWeek, index: number): void {
    setDay(day, { ...draft[day], ranges: draft[day].ranges.toSpliced(index, 1) });
  }

  function updateRange(day: DayOfWeek, index: number, patch: Partial<TimeRange>): void {
    setDay(day, {
      ...draft[day],
      ranges: draft[day].ranges.with(index, { ...draft[day].ranges[index], ...patch }),
    });
  }

  async function handleSave(): Promise<void> {
    if (!canSave) {
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

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <ScrollArea style={{ flex: 1 }} px="lg" py="md">
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap" align="center">
            {overriding ? (
              <Badge color="blue" variant="light" data-testid="schedule-availability-override-badge">
                Custom hours
              </Badge>
            ) : (
              <Badge color="gray" variant="light" data-testid="schedule-availability-default-badge">
                Using service default
              </Badge>
            )}
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={resetToServiceDefault}
              disabled={!overriding}
              data-testid="schedule-availability-reset"
            >
              Reset to service default
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {overriding
              ? 'These hours override the default hours defined on the service.'
              : 'This schedule follows the default hours defined on the service. Editing any day creates an override.'}
          </Text>
          {timezone && (
            <Text size="xs" c="dimmed" data-testid="schedule-availability-timezone">
              Hours are interpreted in the {timezone} timezone.
            </Text>
          )}
          {DAYS_OF_WEEK.map((day) => {
            const { allDay, ranges } = draft[day];
            const available = allDay || ranges.length > 0;
            return (
              <Paper key={day} withBorder radius="md" p="md" data-testid={`schedule-availability-card-${day}`}>
                <Group justify="space-between" wrap="nowrap" align="center">
                  <Text fw={600} size="sm">
                    {DAY_LABELS[day]}
                  </Text>
                  <Switch
                    size="sm"
                    checked={available}
                    onChange={(e) => toggleDay(day, e.currentTarget.checked)}
                    labelPosition="left"
                    label={
                      <Text size="sm" c={available ? undefined : 'dimmed'}>
                        {available ? 'Available' : 'Unavailable'}
                      </Text>
                    }
                    aria-label={`Toggle availability for ${DAY_LABELS[day]}`}
                    data-testid={`schedule-availability-switch-${day}`}
                  />
                </Group>
                {available && (
                  <>
                    <Divider my="sm" />
                    <Checkbox
                      size="sm"
                      checked={allDay}
                      onChange={(e) => toggleAllDay(day, e.currentTarget.checked)}
                      label="Available all day (24 hours)"
                      data-testid={`schedule-availability-all-day-${day}`}
                    />
                  </>
                )}
                {available && !allDay && (
                  <Stack gap="xs" mt="sm">
                    {ranges.map((range, index) => (
                      <Group key={range.id} gap="xs" wrap="nowrap" align="center">
                        <TextInput
                          type="time"
                          aria-label={`${DAY_LABELS[day]} start time ${index + 1}`}
                          data-testid={`schedule-availability-start-${day}-${index}`}
                          value={range.start.slice(0, 5)}
                          onChange={(e) => updateRange(day, index, { start: toTimeOfDay(e.currentTarget.value) })}
                          style={{ flexGrow: 1 }}
                        />
                        <Text size="sm" c="dimmed">
                          to
                        </Text>
                        <TextInput
                          type="time"
                          aria-label={`${DAY_LABELS[day]} end time ${index + 1}`}
                          data-testid={`schedule-availability-end-${day}-${index}`}
                          value={range.end.slice(0, 5)}
                          onChange={(e) => updateRange(day, index, { end: toTimeOfDay(e.currentTarget.value) })}
                          style={{ flexGrow: 1 }}
                        />
                        <ArrayRemoveButton
                          propertyDisplayName="hours"
                          testId={`schedule-availability-remove-${day}-${index}`}
                          onClick={() => removeRange(day, index)}
                        />
                      </Group>
                    ))}
                    <Box>
                      <ArrayAddButton
                        propertyDisplayName="hours"
                        testId={`schedule-availability-add-${day}`}
                        onClick={() => addRange(day)}
                      />
                    </Box>
                    {validation.errors[day] && (
                      <Text size="xs" c="red" data-testid={`schedule-availability-error-${day}`}>
                        {validation.errors[day]}
                      </Text>
                    )}
                    {validation.warnings[day] && (
                      <Text size="xs" c="orange" data-testid={`schedule-availability-warning-${day}`}>
                        {validation.warnings[day]}
                      </Text>
                    )}
                  </Stack>
                )}
              </Paper>
            );
          })}
        </Stack>
      </ScrollArea>
      <Box px="lg" py="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        {emptyOverride && (
          <Text size="xs" c="red" mb="sm" data-testid="schedule-availability-empty-override">
            Custom hours must include at least one available day. To disable this service on the calendar, turn it off
            in schedule settings.
          </Text>
        )}
        <Group justify="flex-end">
          {onCancel && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button onClick={handleSave} loading={saving} disabled={!canSave}>
            Save
          </Button>
        </Group>
      </Box>
    </Box>
  );
}
