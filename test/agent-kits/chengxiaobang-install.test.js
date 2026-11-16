import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {createClientInstallerPort} from '../../src/agent-kits/client-installer.js';

// Optional native acceptance: point to an agent-installer build with the
// Chengxiaobang target. All writes stay in a disposable client home.
test('standard installer port detects, connects, refreshes and removes Chengxiaobang',
  {skip: !process.env.FULI_AGENT_INSTALLER}, async t => {
    const root = mkdtempSync(join(tmpdir(), 'fuli-chengxiaobang-install-'));
    const home = join(root, 'client');
    mkdirSync(home);
    const previous = process.env.CHENGXIAOBANG_HOME;
    process.env.CHENGXIAOBANG_HOME = home;
    t.after(() => {
      if (previous === undefined) delete process.env.CHENGXIAOBANG_HOME;
      else process.env.CHENGXIAOBANG_HOME = previous;
      rmSync(root, {recursive:true, force:true});
    });
    const foreign = {id:'dingdong', event:'Stop', command:'dingdong notify', enabled:true};
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({enabled:true, hooks:[foreign]}));
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({mcpServers:{other:{command:'other'}}}));
    const context = {dataDir:join(root,'data'), nodePath:process.execPath,
      mcpServerPath:resolve('src/mcp-server.js'), runtimeConfigPath:join(root,'runtime.json'), skillsDir:resolve('skills')};
    const installer = createClientInstallerPort({
      executables:{ensure:async()=>({status:'available',path:process.env.FULI_AGENT_INSTALLER})},
      manifestPath:join(root,'manifest.json'), context, backupsDir:join(root,'backups'),
      extensionsDir:join(root,'extensions'), openCode:()=>({plugin:false}), retireLegacy:()=>{}
    });
    const target = status => status.clients.find(c=>c.id==='chengxiaobang');
    const read = name => JSON.parse(readFileSync(join(home,name),'utf8'));
    assert.equal(target(await installer.status()).detected,true);
    const applied = target(await installer.apply(['chengxiaobang']));
    assert.deepEqual(applied.problems,[]);
    assert.equal(target(await installer.status()).state,'connected');
    assert.equal(read('hooks.json').hooks.length,3);
    assert.deepEqual(read('hooks.json').hooks[0],foreign);
    assert.ok(read('mcp.json').mcpServers.fuli.args.includes('other'));
    const text = readFileSync(join(home,'hooks.json'),'utf8');
    await installer.apply(['chengxiaobang']);
    assert.equal(readFileSync(join(home,'hooks.json'),'utf8'),text);
    context.nodePath=join(root,'new node');
    assert.notEqual(target(await installer.status()).state,'connected');
    await installer.apply(['chengxiaobang']);
    assert.equal(read('mcp.json').mcpServers.fuli.command,context.nodePath);
    assert.equal(read('hooks.json').hooks.length,3);
    await installer.remove(['chengxiaobang']);
    assert.deepEqual(read('hooks.json').hooks,[foreign]);
    assert.deepEqual(Object.keys(read('mcp.json').mcpServers),['other']);
  });
