/** Reactive test fixture for component tests; no production session or network work. */
export function painterTestState<T extends object>(value: T): T {
    let state = $state(value)
    return state
}
