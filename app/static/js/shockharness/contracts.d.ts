// Types of the ShockHarness property-contracts runtime (contracts.js beside this file).
// Each declaration returns its first argument with its static type unchanged.

export declare class ContractError extends Error {
  readonly property: string | null;
  readonly function: null;
  constructor(message: string, property: string | null);
}

export declare function requires<T>(value: T, ...properties: string[]): T;
export declare function produces<T>(value: T, ...properties: string[]): T;
export declare function preserves<T>(result: T, source: unknown): T;
export declare function preserves_except<T>(result: T, source: unknown, ...properties: string[]): T;

/** Turn checking on, once, from test code, before any declaration has run. */
export declare function enable(mode: "check" | "verify", staticProperties: string[]): void;

/** The predicate verify mode runs for a property; registered once, at startup. */
export declare function register(
  name: string,
  predicate: (value: unknown) => boolean,
  description: string,
): void;

export interface ContractsReport {
  mode: "off" | "check" | "verify";
  declarations: number;
  static_skips: Record<string, number>;
}

export declare function report(): ContractsReport;
