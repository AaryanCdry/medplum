// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Combobox, Group, InputBase, Tooltip, useCombobox } from '@mantine/core';
import { IconCheck, IconClockExclamation } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  filterTimeOptions,
  formatMinutesOfDay,
  isOnTimeStep,
  nearestOption,
  TIME_STEP_MINUTES,
  timeOptions,
} from './ScheduleAvailabilityEditor.utils';

/**
 * Props for the TimeSelect component.
 * @param value - The selected time, as minutes from midnight
 * @param min - Earliest selectable time, as minutes from midnight
 * @param max - Latest selectable time, as minutes from midnight
 * @param label - Accessible label for the input
 * @param onChange - Called with the newly selected time
 * @param disabled - Whether the input is disabled
 * @param testId - Test id applied to the input
 * @param flashKey - Change this to flash the input, drawing the eye to a value the editor changed on the user's behalf
 */
export interface TimeSelectProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly flashKey?: number;
}

// Long enough to notice, short enough not to linger over the next edit.
const FLASH_DURATION_MS = 700;

// The flash borrows the focus border rather than adding an outline of its own,
// so a value the editor changed looks like a field worth looking at rather than
// a field in error. Easing both ways keeps it from snapping; the transition
// stays on the input at all times so the fade out has something to animate.
const INPUT_STYLES = { input: { transition: 'border-color 450ms' } };

const FLASH_STYLES = {
  input: { ...INPUT_STYLES.input, borderColor: 'var(--mantine-primary-color-filled)' },
};

/**
 * Picks a time of day from a list, with typing as a way to jump through it.
 *
 * The caller decides which times are offered, so the list can be narrowed to the
 * hours still free on a given day. Typing filters that list rather than
 * accepting free text, which keeps every selectable value within the bounds.
 * @param props - The selected time, the bounds it may move within, and a change handler
 * @returns A time picker
 */
export function TimeSelect(props: TimeSelectProps): JSX.Element {
  const { value, min, max, label, onChange, disabled, testId, flashKey } = props;
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });

  // Start the flash while rendering the change that caused it, so it begins in
  // the same paint as the new value.
  const [flashedKey, setFlashedKey] = useState(flashKey);
  if (flashKey !== flashedKey) {
    setFlashedKey(flashKey);
    setFlashing(flashKey !== undefined);
  }

  useEffect(() => {
    if (!flashing) {
      return undefined;
    }
    const timer = setTimeout(() => setFlashing(false), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flashing]);

  // Open onto the current time rather than the top of the list, so the nearby
  // times are the ones in view. `useCombobox` returns a new store object every
  // render, so this keys off the opened flag instead.
  const { dropdownOpened } = combobox;
  useEffect(() => {
    if (!dropdownOpened) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      combobox.selectActiveOption();
      activeOptionRef.current?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropdownOpened]);

  const display = formatMinutesOfDay(value);
  const options = filterTimeOptions(timeOptions(min, max), typing ? query : '', value);
  // A time set elsewhere need not sit on the picker's interval. It is shown as
  // it is and marked, rather than rounded on the user's behalf; the next time
  // they pick lands back on the interval.
  const offStep = !isOnTimeStep(value);
  // Without an exact match there is nothing to scroll to, so the list opens
  // near the current time instead of at the top of the day.
  const scrollTo = options.includes(value) ? value : nearestOption(options, value);

  function handleSubmit(selected: number): void {
    onChange(selected);
    setQuery('');
    setTyping(false);
    combobox.closeDropdown();
    // The state above has not been applied yet, so the blur this causes would
    // otherwise see the old query and commit the same time a second time.
    submitting.current = true;
    inputRef.current?.blur();
    submitting.current = false;
  }

  // Tabbing to the next field is a common way to finish with this one, so a
  // typed time is taken rather than dropped. What gets taken is whatever the
  // list has highlighted, which is the same time Enter would have submitted.
  function handleBlur(): void {
    if (!submitting.current && typing && query) {
      const highlighted = options[combobox.getSelectedOptionIndex()] ?? options[0];
      if (highlighted !== undefined) {
        onChange(highlighted);
      }
    }
    setTyping(false);
    setQuery('');
    combobox.closeDropdown();
  }

  return (
    // A full day holds 289 options, and a week of them adds up, so closed
    // dropdowns are unmounted rather than left hidden in the DOM.
    <Combobox store={combobox} keepMounted={false} onOptionSubmit={(selected) => handleSubmit(Number(selected))}>
      <Combobox.Target>
        <InputBase
          ref={inputRef}
          component="input"
          type="text"
          w={132}
          value={typing ? query : display}
          placeholder={display}
          disabled={disabled}
          aria-label={label}
          data-testid={testId}
          data-flashing={flashing || undefined}
          data-off-step={offStep || undefined}
          styles={flashing ? FLASH_STYLES : INPUT_STYLES}
          leftSection={
            offStep && (
              <Tooltip
                multiline
                w={240}
                withArrow
                label={`${display} was set outside this editor. Times here are picked in ${TIME_STEP_MINUTES} minute steps, so choosing a new one will replace it.`}
              >
                <IconClockExclamation
                  size={15}
                  stroke={1.8}
                  color="var(--mantine-color-dimmed)"
                  data-testid={testId && `${testId}-off-step`}
                />
              </Tooltip>
            )
          }
          leftSectionPointerEvents="all"
          leftSectionWidth={offStep ? 26 : 0}
          rightSection={<Combobox.Chevron />}
          rightSectionPointerEvents="none"
          onChange={(e) => {
            setTyping(true);
            setQuery(e.currentTarget.value);
            combobox.openDropdown();
            combobox.selectFirstOption();
          }}
          onFocus={() => {
            setTyping(true);
            setQuery('');
            combobox.openDropdown();
          }}
          onBlur={handleBlur}
          onClick={() => combobox.openDropdown()}
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options mah={220} style={{ overflowY: 'auto' }}>
          {options.length === 0 ? (
            <Combobox.Empty>No matching time</Combobox.Empty>
          ) : (
            options.map((option) => (
              <Combobox.Option
                key={option}
                value={option.toString()}
                active={option === value}
                ref={option === scrollTo ? activeOptionRef : undefined}
              >
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <span>{formatMinutesOfDay(option)}</span>
                  {option === value && <IconCheck size={14} stroke={1.8} />}
                </Group>
              </Combobox.Option>
            ))
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
