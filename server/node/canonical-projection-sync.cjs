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
        const reconciled = repository.reconcileCanonicalProjection();
        return {
            revision: reconciled.revision,
            database: reconciled.database,
            sidebarWritten: reconciled.sidebarWritten,
        };
    }

    function hasExternalChanges() {
        const revision = repository.getProjectionRevision();
        return Boolean(revision && revision !== readAcceptedRevision());
    }

    function accept(revision = repository.getProjectionRevision()) {
        if (!revision) return null;
        writeAcceptedRevision(revision);
        return revision;
    }

    return { accept, hasExternalChanges, loadExternalChanges };
}

module.exports = { createCanonicalProjectionSync };
