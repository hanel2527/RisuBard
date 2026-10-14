'use strict';

function createCanonicalProjectionSync(options = {}) {
    const repository = options.repository;
    const readAcceptedRevision = options.readAcceptedRevision;
    const writeAcceptedRevision = options.writeAcceptedRevision;
    if (!repository || typeof repository.getProjectionRevision !== 'function'
        || typeof repository.reconcileCanonicalProjection !== 'function') {
        throw new Error('Canonical projection repository is required');
    }
    if (typeof readAcceptedRevision !== 'function' || typeof writeAcceptedRevision !== 'function') {
        throw new Error('Canonical projection revision storage is required');
    }

    function loadExternalChanges() {
        const revision = repository.getProjectionRevision();
        if (!revision || revision === readAcceptedRevision()) return null;
        // Files edited by hand while the app was closed have stale checksums.
        // Validate and adopt them like the retired live file monitor did.
        const reconciled = repository.reconcileCanonicalProjection({ externalEditing: true });
        return {
            revision: reconciled.revision,
            database: reconciled.database,
            sidebarWritten: reconciled.sidebarWritten,
        };
    }

    // Fingerprints of the files the app last accepted, so a review can list
    // every changed file, including rewrites that also refreshed the checksum.
    let acceptedFiles = null;
    const fingerprints = () => typeof repository.getProjectionFingerprints === 'function'
        ? repository.getProjectionFingerprints() : null;

    function hasExternalChanges() {
        if (!acceptedFiles) {
            const state = fingerprints();
            if (state) {
                const unchanged = Boolean(state.revision) && state.revision === readAcceptedRevision();
                if (unchanged) acceptedFiles = state.files;
                return Boolean(state.revision) && !unchanged;
            }
        }
        const revision = repository.getProjectionRevision();
        return Boolean(revision && revision !== readAcceptedRevision());
    }

    // Files added, removed or rewritten since the last accepted revision; null
    // when no baseline was recorded (the review then compares contents instead).
    function changedFiles() {
        const state = acceptedFiles && fingerprints();
        if (!state) return null;
        const changed = [];
        for (const [file, fingerprint] of Object.entries(state.files)) {
            if (!(file in acceptedFiles)) changed.push({ path: file, status: 'added' });
            else if (acceptedFiles[file] !== fingerprint) changed.push({ path: file, status: 'changed' });
        }
        for (const file of Object.keys(acceptedFiles)) {
            if (!(file in state.files)) changed.push({ path: file, status: 'removed' });
        }
        return changed.sort((a, b) => a.path.localeCompare(b.path));
    }

    function accept(revision) {
        const state = revision === undefined ? fingerprints() : null;
        if (revision === undefined) revision = state ? state.revision : repository.getProjectionRevision();
        if (!revision) return null;
        writeAcceptedRevision(revision);
        acceptedFiles = state && state.revision === revision ? state.files : null;
        return revision;
    }

    return { accept, changedFiles, hasExternalChanges, loadExternalChanges };
}

module.exports = { createCanonicalProjectionSync };
