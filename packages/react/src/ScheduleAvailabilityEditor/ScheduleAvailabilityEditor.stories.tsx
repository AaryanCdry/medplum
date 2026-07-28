// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Drawer } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { SchedulingParametersURI } from '@medplum/core';
import type { HealthcareService, Schedule } from '@medplum/fhirtypes';
import type { Meta } from '@storybook/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { Document } from '../Document/Document';
import { ScheduleAvailabilityEditor } from './ScheduleAvailabilityEditor';

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

// An on-call schedule whose windows run past midnight. Friday's window lands on
// Saturday, which has no hours of its own, so Saturday shows a note about it.
const overnightSchedule: Schedule = {
  resourceType: 'Schedule',
  id: 'schedule-4',
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
                { url: 'daysOfWeek', valueCode: 'thu' },
                { url: 'availableStartTime', valueTime: '22:00:00' },
                { url: 'availableEndTime', valueTime: '06:00:00' },
              ],
            },
            {
              url: 'availableTime',
              extension: [
                { url: 'daysOfWeek', valueCode: 'fri' },
                { url: 'availableStartTime', valueTime: '22:00:00' },
                { url: 'availableEndTime', valueTime: '06:00:00' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// The editor renders form content only, so the container is the caller's
// choice. This story puts it in a Drawer, the way the provider app does.
function EditorStory(props: { schedule: Schedule }): JSX.Element {
  const [opened, handlers] = useDisclosure(true);
  const [schedule, setSchedule] = useState(props.schedule);

  return (
    <Document>
      <Button onClick={handlers.open}>Edit weekly hours</Button>
      <Drawer
        opened={opened}
        onClose={handlers.close}
        position="right"
        size="md"
        padding={0}
        title="Weekly availability"
        styles={{
          content: { display: 'flex', flexDirection: 'column' },
          body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 },
        }}
      >
        <ScheduleAvailabilityEditor
          schedule={schedule}
          service={service}
          onCancel={handlers.close}
          onSave={(updated) => {
            setSchedule(updated);
            handlers.close();
          }}
        />
      </Drawer>
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

// Overnight hours, showing the next-day disclosure and the spillover note.
export const OvernightHours = (): JSX.Element => <EditorStory schedule={overnightSchedule} />;

// No SchedulingParameters at all; seeds from the service default.
export const NoAvailability = (): JSX.Element => <EditorStory schedule={emptySchedule} />;

// The same editor placed directly on the page instead of in a Drawer.
export const Inline = (): JSX.Element => {
  const [schedule, setSchedule] = useState(scheduleWithHours);
  return (
    <Document>
      <ScheduleAvailabilityEditor schedule={schedule} service={service} onSave={setSchedule} />
    </Document>
  );
};
