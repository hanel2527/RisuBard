'use strict';

function registerCharacterPackageRoutes(app, { auth, activeSession, queue, prepare, repository, assets, readSource }) {
    const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
    const result = characterId => ({
        ...repository.characterDirectoryStatus(characterId),
        assets: assets.status(characterId),
        diagnostics: assets.diagnostics(),
    });

    app.get('/api/character-packages/status', async (req, res, next) => {
        if (!await auth(req, res)) return;
        if (!valid(req.query.characterId)) return res.status(400).json({ error: 'Invalid character ID' });
        try { res.json(result(req.query.characterId)); }
        catch (error) { next(error); }
    });

    app.post('/api/character-packages/transition', async (req, res) => {
        if (!await auth(req, res) || !activeSession(req, res)) return;
        const { characterId, action } = req.body || {};
        if (!valid(characterId) || !['migrate', 'refresh', 'rollback'].includes(action)) {
            return res.status(400).json({ error: 'Explicit character and action required' });
        }
        try {
            await queue(async () => {
                const database = await prepare();
                if (!database) return res.status(409).json({ error: 'Save pending or canonical files unavailable' });
                if (database.characters?.filter(character => character.chaId === characterId).length !== 1) {
                    return res.status(404).json({ error: 'Character unavailable' });
                }
                if (action === 'rollback') {
                    repository.rollbackCharacterDirectoryMapping(characterId);
                    assets.reload();
                    assets.disable(characterId);
                    return res.json(result(characterId));
                }
                const alreadyEnabled = repository.characterDirectoryStatus(characterId).enabled;
                if (alreadyEnabled) {
                    repository.refreshCharacterDirectoryMapping(characterId);
                } else {
                    assets.migrate(database, characterId, readSource);
                    repository.publishCharacterDirectoryMapping(characterId);
                }
                assets.reload();
                if (action === 'refresh' && alreadyEnabled) assets.migrate(database, characterId, readSource);
                res.json(result(characterId));
            });
        } catch {
            res.status(500).json({ error: 'Character package transition failed; recoverable source data was retained' });
        }
    });
}

module.exports = { registerCharacterPackageRoutes };
