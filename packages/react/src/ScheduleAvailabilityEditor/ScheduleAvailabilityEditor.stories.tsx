// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button } from '@mantine/core';
import type { HealthcareService, Schedule } from '@medplum/fhirtypes';
import type { Meta } from '@storybook/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { Document } from '../Document/Document';
import { ScheduleAvailabilityEditor } from './ScheduleAvailabilityEditor';
import { SchedulingParametersURI } from './ScheduleAvailabilityEditor.utils';

export default {
  title: 'Medplum/ScheduleAvailabilityEditor',
  component: ScheduleAvailabilityEditor,
} as Meta;

const service: HealthcareService = {
  resourceType: 'HealthcareService',
  id: 'service-1',
  name: 'New Patient Visit',
  // Service-level default hours, inherited by schedules that have no override.
  availableTime: [
    { daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'], availableStartTime: '09:00:00', availableEndTime: '17:00:00' },
  ],
};

const scheduleWithHours: Schedule = {
  resourceType: 'Schedule',
  id: 'schedule-1',
  actor: [{ reference: 'Practitioner/123', display: 'Dr. Alice Smith' }],
  extension: [
    {
      url: SchedulingParametersURI,
      extension: [
        { url: 'service', valueReference: { reference: 'HealthcareService/service-1' } },
        { url: 'duration', valueDuration: { value: 30, unit: 'min' } },
        { url: 'timezone', valueCode: 'America/New_York' },
        {
          url: 'availability',
          extension: [
            {
              url: 'availableTime',
              extension: [
                { url: 'daysOfWeek', valueCode: 'mon' },
                { url: 'availableStartTime', valueTime: '09:00:00' },
                { url: 'availableEndTime', valueTime: '12:00:00' },
              ],
            },
            {
              url: 'availableTime',
              extension: [
                { url: 'daysOfWeek', valueCode: 'mon' },
                { url: 'availableStartTime', valueTime: '13:00:00' },
                { url: 'availableEndTime', valueTime: '17:00:00' },
              ],
            },
            {
              url: 'availableTime',
              extension: [
                { url: 'daysOfWeek', valueCode: 'wed' },
                { url: 'availableStartTime', valueTime: '09:00:00' },
                { url: 'availableEndTime', valueTime: '17:00:00' },
              ],
            },
            {
              url: 'availableTime',
              extension: [
                { url: 'daysOfWeek', valueCode: 'fri' },
                { url: 'allDay', valueBoolean: true },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const emptySchedule: Schedule = {
  resourceType: 'Schedule',
  id: 'schedule-2',
  actor: [{ reference: 'Practitioner/123', display: 'Dr. Alice Smith' }],
};

function EditorStory(props: { schedule: Schedule }): JSX.Element {
  const [opened, setOpened] = useState(true);
  const [schedule, setSchedule] = useState(props.schedule);

  return (
    <Document>
      <Button onClick={() => setOpened(true)}>Edit weekly hours</Button>
      <ScheduleAvailabilityEditor
        schedule={schedule}
        service={service}
        opened={opened}
        onClose={() => setOpened(false)}
        onSave={(updated) => setSchedule(updated)}
      />
    </Document>
  );
}

// Schedule with a SchedulingParameters block but no availability override; the
// editor seeds from the service default and shows the "Using service default" badge.
const inheritingSchedule: Schedule = {
  resourceType: 'Schedule',
  id: 'schedule-3',
  actor: [{ reference: 'Practitioner/123', display: 'Dr. Alice Smith' }],
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

// Custom hours overriding the service default.
export const CustomHoursOverride = (): JSX.Element => <EditorStory schedule={scheduleWithHours} />;

// Inherits the service default; editing any day creates an override.
export const InheritingServiceDefault = (): JSX.Element => <EditorStory schedule={inheritingSchedule} />;

// No SchedulingParameters at all; seeds from the service default.
export const NoAvailability = (): JSX.Element => <EditorStory schedule={emptySchedule} />;
