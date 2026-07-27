// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import type { HealthcareService, Schedule } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ArrayAddButton } from '../buttons/ArrayAddButton';
import { ArrayRemoveButton } from '../buttons/ArrayRemoveButton';
import type { DayOfWeek, TimeRange, WeeklyAvailability } from './ScheduleAvailabilityEditor.utils';
import {
  applyWeeklyAvailability,
  clearAvailabilityOverride,
  DAY_LABELS,
  DAYS_OF_WEEK,
  emptyWeeklyAvailability,
  getSchedulingTimezone,
  hasAvailabilityOverride,
  parseServiceAvailability,
  parseWeeklyAvailability,
  validateWeeklyAvailability,
} from './ScheduleAvailabilityEditor.utils';

const DEFAULT_RANGE: TimeRange = { start: '09:00:00', end: '17:00:00' };

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
  /**
   * The service whose availability is being edited. May be `undefined` while the
   * drawer is closed. Keep the component mounted and toggle `opened` (rather than
   * conditionally rendering it) so the open/close animations play; Mantine only
   * animates a transition that is already mounted when `opened` changes.
   */
  readonly service: HealthcareService | undefined;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onSave: (updatedSchedule: Schedule) => void | Promise<void>;
  /** Called after the close transition finishes, e.g. to clear the selected service. */
  readonly onExitTransitionEnd?: () => void;
}

function toDraft(weekly: WeeklyAvailability, nextId: { current: number }): DraftAvailability {
  const draft = {} as DraftAvailability;
  for (const day of DAYS_OF_WEEK) {
    draft[day] = {
      allDay: weekly[day].allDay,
      ranges: weekly[day].ranges.map((range) => ({ ...range, id: nextId.current++ })),
    };
  }
  return draft;
}

function toWeekly(draft: DraftAvailability): WeeklyAvailability {
  const weekly = emptyWeeklyAvailability();
  for (const day of DAYS_OF_WEEK) {
    weekly[day] = {
      allDay: draft[day].allDay,
      ranges: draft[day].ranges.map((range) => ({ start: range.start, end: range.end })),
    };
  }
  return weekly;
}

export function ScheduleAvailabilityEditor(props: ScheduleAvailabilityEditorProps): JSX.Element {
  const { schedule, service, opened, onClose, onSave, onExitTransitionEnd } = props;
  const nextId = useRef(0);
  const [draft, setDraft] = useState<DraftAvailability>(() => emptyDraft());
  const [saving, setSaving] = useState(false);
  // Whether the draft will be saved as a Schedule-level override. When false,
  // the draft mirrors the inherited service default and saving clears any override.
  const [overriding, setOverriding] = useState(false);

  // Reset the draft from the current Schedule whenever the drawer is (re)opened
  // or the target service changes. If the Schedule has no override for this
  // service, seed from the service-level default so the editor shows the hours
  // currently in effect rather than a blank week.
  useEffect(() => {
    if (opened && service) {
      nextId.current = 0;
      const override = hasAvailabilityOverride(schedule, service);
      const weekly = override ? parseWeeklyAvailability(schedule, service) : parseServiceAvailability(service);
      setOverriding(override);
      setDraft(toDraft(weekly, nextId));
    }
  }, [opened, schedule, service]);

  const timezone = service ? getSchedulingTimezone(schedule, service) : undefined;
  const validation = validateWeeklyAvailability(toWeekly(draft));

  // Any manual edit diverges from the service default, so mark the draft as an override.
  function setDay(day: DayOfWeek, value: DayDraft): void {
    setOverriding(true);
    setDraft((prev) => ({ ...prev, [day]: value }));
  }

  // Discard the override and restore the inherited service-default hours.
  function resetToServiceDefault(): void {
    if (!service) {
      return;
    }
    nextId.current = 0;
    setDraft(toDraft(parseServiceAvailability(service), nextId));
    setOverriding(false);
  }

  function toggleDay(day: DayOfWeek, available: boolean): void {
    if (available) {
      setDay(day, { allDay: false, ranges: [{ ...DEFAULT_RANGE, id: nextId.current++ }] });
    } else {
      setDay(day, { allDay: false, ranges: [] });
    }
  }

  function toggleAllDay(day: DayOfWeek, allDay: boolean): void {
    if (allDay) {
      setDay(day, { allDay: true, ranges: [] });
    } else {
      setDay(day, { allDay: false, ranges: [{ ...DEFAULT_RANGE, id: nextId.current++ }] });
    }
  }

  function addRange(day: DayOfWeek): void {
    setDay(day, { ...draft[day], ranges: [...draft[day].ranges, { ...DEFAULT_RANGE, id: nextId.current++ }] });
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
    if (!validation.valid || !service) {
      return;
    }
    setSaving(true);
    try {
      const updated = overriding
        ? applyWeeklyAvailability(schedule, service, toWeekly(draft))
        : clearAvailabilityOverride(schedule, service);
      await onSave(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      onExitTransitionEnd={onExitTransitionEnd}
      position="right"
      size="md"
      padding={0}
      overlayProps={{ backgroundOpacity: 0.5, blur: 2 }}
      transitionProps={{ transition: 'slide-left', duration: 250, timingFunction: 'ease' }}
      title={
        <Box>
          <Text fw={600} size="lg">
            Weekly availability
          </Text>
          {service?.name && (
            <Text size="sm" c="dimmed">
              {service.name}
            </Text>
          )}
        </Box>
      }
      styles={{
        content: { display: 'flex', flexDirection: 'column' },
        header: {
          paddingInline: 'var(--mantine-spacing-lg)',
          paddingBlock: 'var(--mantine-spacing-md)',
          borderBottom: '1px solid var(--mantine-color-default-border)',
        },
        body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 },
      }}
    >
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
            <Text size="xs" c="dimmed">
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
                          onChange={(e) => updateRange(day, index, { start: `${e.currentTarget.value}:00` })}
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
                          onChange={(e) => updateRange(day, index, { end: `${e.currentTarget.value}:00` })}
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
                  </Stack>
                )}
              </Paper>
            );
          })}
        </Stack>
      </ScrollArea>
      <Box px="lg" py="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!validation.valid}>
            Save
          </Button>
        </Group>
      </Box>
    </Drawer>
  );
}

function emptyDraft(): DraftAvailability {
  const draft = {} as DraftAvailability;
  for (const day of DAYS_OF_WEEK) {
    draft[day] = { allDay: false, ranges: [] };
  }
  return draft;
}
