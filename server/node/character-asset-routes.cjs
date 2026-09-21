'use strict';

function registerCharacterAssetRoutes(app, { auth, activeSession, queue, prepare, assets, readSource }) {
    const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
    app.get('/api/character-assets/status', async (req, res, next) => {
        if (!await auth(req, res)) return;
        if (!valid(req.query.characterId)) return res.status(400).json({ error: 'Invalid character ID' });
        try { res.json({ ...assets.status(req.query.characterId), diagnostics: assets.diagnostics() }); }
        catch (error) { next(error); }
    });
    app.post('/api/character-assets/transition', async (req, res, next) => {
        if (!await auth(req, res) || !activeSession(req, res)) return;
        const { characterId, action } = req.body || {};
        if (!valid(characterId) || !['migrate', 'disable'].includes(action)) return res.status(400).json({ error: 'Explicit character and action required' });
        try {
            await queue(async () => {
                // Disabling a replica must remain possible even when canonical files are unavailable.
                if (action === 'disable') {
                    return res.json({ ...assets.disable(characterId), diagnostics: assets.diagnostics() });
                }
                const database = await prepare();
                if (!database) return res.status(409).json({ error: 'Save pending or canonical files unavailable' });
                if (database.characters?.filter(character => character.chaId === characterId).length !== 1) return res.status(404).json({ error: 'Character unavailable' });
                const result = assets.migrate(database, characterId, readSource);
                res.json({ ...result, diagnostics: assets.diagnostics() });
            });
        } catch { res.status(500).json({ error: 'Asset transition failed; original KV files retained' }); }
    });
}
module.exports = { registerCharacterAssetRoutes };
