/** Bounded cache for repeated plugin reads, including in-flight requests. */
export class PluginContextCache<T> {
    private entries = new Map<string, { value: Promise<T>, expires: number }>()

    private ttlMs: number
    private maximumEntries: number

    constructor(ttlMs = 30_000, maximumEntries = 32) {
        this.ttlMs = ttlMs
        this.maximumEntries = maximumEntries
    }

    clear(): void {
        this.entries.clear()
    }

    get(key: string, load: () => Promise<T>): Promise<T> {
        const cached = this.entries.get(key)
        if (cached && cached.expires > Date.now()) return cached.value
        if (cached) this.entries.delete(key)
        const entry = { value: undefined as unknown as Promise<T>, expires: Infinity }
        entry.value = Promise.resolve().then(load).then((value) => {
            entry.expires = Date.now() + this.ttlMs
            return value
        }, (error) => {
            if (this.entries.get(key) === entry) this.entries.delete(key)
            throw error
        })
        this.entries.set(key, entry)
        while (this.entries.size > this.maximumEntries) {
            this.entries.delete(this.entries.keys().next().value!)
        }
        return entry.value
    }
}
