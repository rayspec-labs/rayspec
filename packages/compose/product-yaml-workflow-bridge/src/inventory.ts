import type { CapabilityInventory } from './types.js';

// The manifest shapes below describe the capability-contract inputs the inventory is built from: a
// Tier-B contracts manifest (capabilities + their operation/event contracts), an STT contracts
// manifest, and an artifact-node manifest (the workflow-compatible operations + events). They are
// intentionally loose (unknown-typed) — the runtime parser is the strict gate; this factory only
// projects the declared contract ids into the neutral CapabilityInventory the compiler validates against.

interface CapabilityContractEntry extends Record<string, unknown> {
  id?: unknown;
  kind?: unknown;
}

interface CapabilityEntry extends Record<string, unknown> {
  contracts?: unknown;
}

interface TierBContractsManifest {
  capabilities?: unknown;
}

interface SttContractsManifest {
  capability?: {
    contracts?: unknown;
  };
}

interface ArtifactNodeOperation extends Record<string, unknown> {
  id?: unknown;
  outputs?: unknown;
}

interface ArtifactNodeEvent extends Record<string, unknown> {
  id?: unknown;
}

interface ArtifactNodesManifest {
  capability_nodes?: {
    operations?: unknown;
    events?: unknown;
  };
}

export function createCapabilityInventoryFromManifests(
  tierBContracts: TierBContractsManifest,
  sttContracts: SttContractsManifest,
  artifactNodes?: ArtifactNodesManifest,
): CapabilityInventory {
  const operations = new Set<string>();
  const contracts = new Set<string>();
  const events = new Set<string>();

  for (const capability of arrayOfRecords<CapabilityEntry>(tierBContracts.capabilities)) {
    for (const contract of arrayOfRecords<CapabilityContractEntry>(capability.contracts)) {
      if (typeof contract.id !== 'string') continue;
      contracts.add(contract.id);
      if (contract.kind === 'operation') operations.add(contract.id);
      if (contract.kind === 'event') events.add(contract.id);
    }
  }

  for (const contractId of arrayOfStrings(sttContracts.capability?.contracts)) {
    contracts.add(contractId);
    if (contractId === 'stt.transcribe_session' || contractId === 'stt.transcribe_track') {
      operations.add(contractId);
    }
  }

  for (const operation of arrayOfRecords<ArtifactNodeOperation>(
    artifactNodes?.capability_nodes?.operations,
  )) {
    if (typeof operation.id !== 'string') continue;
    operations.add(operation.id);
    contracts.add(operation.id);
    for (const output of arrayOfStrings(operation.outputs)) {
      contracts.add(output);
    }
  }

  for (const event of arrayOfRecords<ArtifactNodeEvent>(artifactNodes?.capability_nodes?.events)) {
    if (typeof event.id !== 'string') continue;
    contracts.add(event.id);
    events.add(event.id);
  }

  return { operations, contracts, events };
}

function arrayOfRecords<T extends Record<string, unknown>>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is T => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
