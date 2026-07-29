// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  CodeableConcept,
  Extension,
  HealthcareService,
  HealthcareServiceAvailableTime,
  Reference,
  Resource,
  Schedule,
} from '@medplum/fhirtypes';
import type { WithId } from './utils';
import { createReference, deepClone, getExtension, getExtensionValue, getReferenceString, isDefined } from './utils';

export const SchedulingParametersURI = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';
export const ServiceTypeReferenceURI = 'https://medplum.com/fhir/service-type-reference';
export const TimezoneExtensionURI = 'http://hl7.org/fhir/StructureDefinition/timezone';

export const DAYS_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export function isDayOfWeek(value: string | undefined): value is DayOfWeek {
  return DAYS_OF_WEEK.includes(value as DayOfWeek);
}

/**
 * Returns whether a Schedule or HealthcareService has a SchedulingParameters extension.
 * @param resource - Schedule or HealthcareService to inspect
 * @returns True if the resource has a SchedulingParameters extension
 */
export function hasSchedulingParameters(resource: Schedule | HealthcareService): boolean {
  return !!getExtension(resource, SchedulingParametersURI);
}

function matchesServiceSchedulingParameters(extension: Extension, serviceReference: string): boolean {
  return (
    extension.url === SchedulingParametersURI &&
    (extension.extension?.some(
      (subextension) => subextension.url === 'service' && subextension.valueReference?.reference === serviceReference
    ) ??
      false)
  );
}

/**
 * Finds the SchedulingParameters extensions on a Schedule for a HealthcareService.
 * @param schedule - Schedule to inspect
 * @param service - HealthcareService referenced by the desired parameters
 * @returns Every matching SchedulingParameters extension, in document order
 */
export function getServiceSchedulingParameters(schedule: Schedule, service: HealthcareService): Extension[] {
  const reference = getReferenceString(service);
  if (!reference) {
    return [];
  }
  return schedule.extension?.filter((extension) => matchesServiceSchedulingParameters(extension, reference)) ?? [];
}

function getSubExtensions(extension: Extension | undefined, url: string): Extension[] {
  return extension?.extension?.filter((subextension) => subextension.url === url) ?? [];
}

// Convert a single `SchedulingParameters.availability.availableTime`
// sub-sub-extension into a HealthcareServiceAvailableTime. Note that
// `daysOfWeek` repeats once per day value rather than holding an array.
function toAvailableTime(availableTime: Extension): HealthcareServiceAvailableTime {
  const daysOfWeek = getSubExtensions(availableTime, 'daysOfWeek')
    .map((subextension) => subextension.valueCode)
    .filter(isDayOfWeek);

  if (getSubExtensions(availableTime, 'allDay')[0]?.valueBoolean) {
    return { daysOfWeek, allDay: true };
  }

  return {
    daysOfWeek,
    availableStartTime: getSubExtensions(availableTime, 'availableStartTime')[0]?.valueTime,
    availableEndTime: getSubExtensions(availableTime, 'availableEndTime')[0]?.valueTime,
  };
}

function getAvailabilityOverride(
  schedule: Schedule,
  service: HealthcareService
): HealthcareServiceAvailableTime[] | undefined {
  const availability = getServiceSchedulingParameters(schedule, service).flatMap((parameters) =>
    getSubExtensions(parameters, 'availability')
  );

  if (!availability.length) {
    return undefined;
  }

  return availability.flatMap((extension) => getSubExtensions(extension, 'availableTime')).map(toAvailableTime);
}

/**
 * Resolves the availability in effect for a Schedule/HealthcareService pair.
 * A Schedule-level override wins over the service default when present.
 * @param schedule - Schedule that may override the service default
 * @param service - HealthcareService providing the default availability
 * @returns The availability in effect, or undefined when none is configured
 */
export function extractAvailability(
  schedule: Schedule | undefined,
  service: HealthcareService | undefined
): HealthcareServiceAvailableTime[] | undefined {
  if (!service) {
    return undefined;
  }

  const override = schedule && getAvailabilityOverride(schedule, service);
  return override ?? service.availableTime;
}

/**
 * Returns whether a Schedule overrides a HealthcareService's default availability.
 * @param schedule - Schedule to inspect
 * @param service - HealthcareService referenced by the desired parameters
 * @returns True if matching parameters contain an availability override
 */
export function hasAvailabilityOverride(schedule: Schedule, service: HealthcareService): boolean {
  return getServiceSchedulingParameters(schedule, service).some((parameters) =>
    parameters.extension?.some((subextension) => subextension.url === 'availability')
  );
}

/**
 * Builds the SchedulingParameters availability sub-extension.
 * @param availableTime - Availability to serialize
 * @returns An availability extension containing availableTime entries
 */
export function buildAvailabilityExtension(availableTime: HealthcareServiceAvailableTime[]): Extension {
  return {
    url: 'availability',
    extension: availableTime.map((entry) => {
      const days: Extension[] = (entry.daysOfWeek ?? []).map((day) => ({ url: 'daysOfWeek', valueCode: day }));
      if (entry.allDay) {
        return { url: 'availableTime', extension: [...days, { url: 'allDay', valueBoolean: true }] };
      }
      return {
        url: 'availableTime',
        extension: [
          ...days,
          { url: 'availableStartTime', valueTime: entry.availableStartTime },
          { url: 'availableEndTime', valueTime: entry.availableEndTime },
        ],
      };
    }),
  };
}

/**
 * Immutably applies an availability override to a Schedule for a HealthcareService.
 * @param schedule - Schedule to update
 * @param service - HealthcareService referenced by the parameters
 * @param availableTime - Availability to apply
 * @returns A cloned Schedule containing the availability override
 */
export function applyAvailability(
  schedule: Schedule,
  service: HealthcareService,
  availableTime: HealthcareServiceAvailableTime[]
): Schedule {
  // Start from a cleared clone so a Schedule carrying more than one matching
  // SchedulingParameters extension cannot keep a stale override behind.
  const updated = clearAvailabilityOverride(schedule, service);
  const serviceReference = createReference(service);

  updated.extension ??= [];

  let parameters = updated.extension.find((extension) =>
    matchesServiceSchedulingParameters(extension, serviceReference.reference)
  );

  if (!parameters) {
    parameters = {
      url: SchedulingParametersURI,
      extension: [{ url: 'service', valueReference: serviceReference }],
    };
    updated.extension.push(parameters);
  }

  parameters.extension = [...(parameters.extension ?? []), buildAvailabilityExtension(availableTime)];

  return updated;
}

/**
 * Immutably clears a Schedule's availability override for a HealthcareService.
 * @param schedule - Schedule to update
 * @param service - HealthcareService referenced by the parameters
 * @returns A cloned Schedule without the matching availability override
 */
export function clearAvailabilityOverride(schedule: Schedule, service: HealthcareService): Schedule {
  const updated = deepClone(schedule);

  for (const parameters of getServiceSchedulingParameters(updated, service)) {
    if (parameters.extension) {
      parameters.extension = parameters.extension.filter((subextension) => subextension.url !== 'availability');
    }
  }

  return updated;
}

/**
 * Resolves the timezone used by scheduling in server priority order:
 * Schedule parameters, HealthcareService parameters, then the actor's standard
 * FHIR timezone extension.
 * @param schedule - Schedule whose parameters may define a timezone. Omit to resolve the service's own timezone,
 * as when the service default hours are being read on their own rather than through a particular calendar.
 * @param service - HealthcareService whose parameters may define a timezone
 * @param actor - Optional Schedule actor used as a timezone fallback
 * @returns The resolved IANA timezone identifier, if present
 */
export function getSchedulingTimezone(
  schedule: Schedule | undefined,
  service: HealthcareService,
  actor?: Resource
): string | undefined {
  const scheduleTimezone = (schedule ? getServiceSchedulingParameters(schedule, service) : [])
    .flatMap((parameters) => getSubExtensions(parameters, 'timezone'))
    .map((subextension) => subextension.valueCode)
    .find(isDefined);
  if (scheduleTimezone) {
    return scheduleTimezone;
  }

  const serviceTimezone = getSubExtensions(getExtension(service, SchedulingParametersURI), 'timezone')
    .map((subextension) => subextension.valueCode)
    .find(isDefined);
  if (serviceTimezone) {
    return serviceTimezone;
  }

  const actorTimezone = actor && getExtensionValue(actor, TimezoneExtensionURI);
  return typeof actorTimezone === 'string' ? actorTimezone : undefined;
}

/**
 * Converts a HealthcareService into the CodeableConcept values used by
 * `Schedule.serviceType` and `Appointment.serviceType`, which encode an R4
 * approximation of `CodeableReference<HealthcareService>`.
 * @param service - HealthcareService to represent
 * @returns CodeableConcept values containing a reference to the service
 */
export function toServiceTypeCodeableConcepts(service: WithId<HealthcareService>): CodeableConcept[] {
  const extension = [{ url: ServiceTypeReferenceURI, valueReference: createReference(service) }];
  if (!service.type?.length) {
    return [{ extension }];
  }
  return service.type.map((concept) => ({
    ...concept,
    extension: [...(concept.extension ?? []), ...extension],
  }));
}

/**
 * Returns whether any serviceType concept refers to the given HealthcareService.
 * @param serviceType - CodeableConcept values to inspect
 * @param service - HealthcareService or reference to match
 * @returns True if any concept references the service
 */
export function serviceTypeIncludesService(
  serviceType: CodeableConcept[] | undefined,
  service: WithId<HealthcareService> | (Reference<HealthcareService> & { reference: string })
): boolean {
  const reference = getReferenceString(service);
  return extractServiceTypeReferences(serviceType).some((serviceReference) => serviceReference.reference === reference);
}

/**
 * Extracts HealthcareService references from serviceType concepts.
 * @param serviceType - CodeableConcept values to inspect
 * @returns HealthcareService references embedded in the concepts
 */
export function extractServiceTypeReferences(
  serviceType: CodeableConcept[] | undefined
): Reference<HealthcareService>[] {
  if (!serviceType?.length) {
    return [];
  }
  return serviceType
    .map((concept) => getExtensionValue(concept, ServiceTypeReferenceURI) as Reference<HealthcareService> | undefined)
    .filter(isDefined);
}
