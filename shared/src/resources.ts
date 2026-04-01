export const resourceTypes = {
  points: 'points',
  coins: 'coins',
} as const;

export type BuiltInResourceType = (typeof resourceTypes)[keyof typeof resourceTypes];
export type ResourceType = BuiltInResourceType | (string & {});
export const RESOURCE_TYPE_VALUES = Object.values(resourceTypes) as BuiltInResourceType[];

export interface ResourceDefinition {
  label: string;
  scope: 'team' | 'player';
  description: string;
}

export const resourceDefinitions = {
  points: {
    label: 'Points',
    scope: 'team',
    description: 'Primary scoring resource for Territory win conditions and standings.',
  },
  coins: {
    label: 'Coins',
    scope: 'team',
    description: 'Secondary team currency reserved for future Territory mechanics.',
  },
} as const satisfies Record<BuiltInResourceType, ResourceDefinition>;
