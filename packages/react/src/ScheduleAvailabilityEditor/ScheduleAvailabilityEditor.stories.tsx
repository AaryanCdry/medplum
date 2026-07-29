// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Title } from '@mantine/core';
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
  name: 'Follow-Up Visit',
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

// An on-call schedule whose windows run past midnight. The editor cannot author
// these, so it splits them at midnight on mount: Thursday 10:00 PM to 12:00 AM
// plus Friday 12:00 AM to 6:00 AM, and so on.
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

// Hours written by the API at times the pickers do not offer. The editor shows
// them as stored and marks them, rather than rounding hours nobody asked it to
// change.
const offIntervalSchedule: Schedule = {
  resourceType: 'Schedule',
  id: 'schedule-5',
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
                { url: 'daysOfWeek', valueCode: 'tue' },
                { url: 'availableStartTime', valueTime: '09:07:00' },
                { url: 'availableEndTime', valueTime: '16:43:00' },
              ],
            },
            {
              url: 'availableTime',
              extension: [
                { url: 'daysOfWeek', valueCode: 'thu' },
                { url: 'availableStartTime', valueTime: '09:00:00' },
                { url: 'availableEndTime', valueTime: '17:00:00' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// The editor renders form content only, so the heading and the container are
// the caller's choice. These stories show it on a page; the provider app puts
// the same component in a Modal.
function EditorStory(props: { schedule: Schedule; onCancel?: () => void }): JSX.Element {
  const [schedule, setSchedule] = useState(props.schedule);

  return (
    <Document>
      <Title order={3} mb="xs">
        Weekly Availability for {service.name}
      </Title>
      <ScheduleAvailabilityEditor
        schedule={schedule}
        service={service}
        onCancel={props.onCancel}
        onSave={setSchedule}
      />
    </Document>
  );
}

// Schedule with a SchedulingParameters block but no availability override; the
// editor seeds from the service default with the override switch off.
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

// Custom hours overriding the service default, including a split day and a full
// 24 hour day.
export const CustomHoursOverride = (): JSX.Element => <EditorStory schedule={scheduleWithHours} />;

// Inherits the service default; the day rows are read-only until custom
// availability is switched on.
export const InheritingServiceDefault = (): JSX.Element => <EditorStory schedule={inheritingSchedule} />;

// Stored hours that run past midnight, split across days on mount.
export const OvernightHours = (): JSX.Element => <EditorStory schedule={overnightSchedule} />;

// Stored hours that fall between the times the pickers offer, shown as stored
// and marked.
export const OffIntervalHours = (): JSX.Element => <EditorStory schedule={offIntervalSchedule} />;

// No SchedulingParameters at all; seeds from the service default.
export const NoAvailability = (): JSX.Element => <EditorStory schedule={emptySchedule} />;

// Passing onCancel adds a Cancel button beside Save, for hosts that can be
// dismissed. Without it, Save is the only action and spans the full width.
export const WithCancel = (): JSX.Element => <EditorStory schedule={scheduleWithHours} onCancel={() => undefined} />;
