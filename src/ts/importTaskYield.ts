/** Schedules one import continuation as a browser task without timer throttling. */
export function yieldImportTask(): Promise<void> {
    return new Promise((resolve) => {
        const channel = new MessageChannel()
        const finish = () => {
            channel.port1.onmessage = null
            channel.port1.close()
            channel.port2.close()
            resolve()
        }

        channel.port1.onmessage = finish
        channel.port2.postMessage(undefined)
    })
}
