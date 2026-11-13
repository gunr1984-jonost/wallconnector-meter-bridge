export class DurableObject<E = unknown> {
  constructor(
    protected ctx: { storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } },
    protected env: E,
  ) {}
}
