import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileKnowledgeWrites, useKnowledgeWriteLifecycle } from './knowledge-write-lifecycle'

afterEach(() => vi.useRealTimers())
describe('knowledge write lifecycle', () => {
  function fixture() {
    reconcileKnowledgeWrites('space-a'); reconcileKnowledgeWrites('space-b')
    const identity = ref('space-a:entity:same')
    let lifecycle!: ReturnType<typeof useKnowledgeWriteLifecycle>
    const denied = vi.fn()
    const wrapper = mount(defineComponent({ setup() { lifecycle = useKnowledgeWriteLifecycle(() => identity.value, denied); return () => null } }))
    return { identity, lifecycle, denied, wrapper }
  }
  it('ignores success/error after changing kind or space and never completes the next operation', async () => {
    const f = fixture(); let resolve!: () => void
    const success = vi.fn()
    const first = f.lifecycle.run(() => new Promise<void>(r => { resolve = r }), success)
    expect(f.lifecycle.busy.value).toBe(true)
    f.identity.value = 'space-b:relationship:same'; await flushPromises()
    expect(f.lifecycle.busy.value).toBe(false)
    resolve(); await first
    expect(success).not.toHaveBeenCalled()
    f.wrapper.unmount()
  })
  it('shows 8s action delay and locks unconfirmed writes at 30s without retry or late completion', async () => {
    vi.useFakeTimers();const f=fixture();let resolve!: () => void;const success=vi.fn();const request=vi.fn(() => new Promise<void>(r=>{resolve=r}))
    const pending=f.lifecycle.run(request,success)
    await vi.advanceTimersByTimeAsync(8000);expect(f.lifecycle.takingLong.value).toBe(true)
    await vi.advanceTimersByTimeAsync(22000);await pending
    expect(f.lifecycle.busy.value).toBe(false);expect(f.lifecycle.locked.value).toBe(true)
    expect(f.lifecycle.error.value).toContain('保存结果未确认')
    await f.lifecycle.run(request,success);expect(request).toHaveBeenCalledTimes(1)
    resolve();await flushPromises();expect(success).not.toHaveBeenCalled()
    f.wrapper.unmount()
  })
  it.each([401,403])('notifies the owner of %s without keeping private form state',async status=>{
    const f=fixture();const success=vi.fn();await f.lifecycle.run(()=>Promise.reject({status}),success)
    expect(f.denied).toHaveBeenCalledTimes(1);expect(success).not.toHaveBeenCalled();f.wrapper.unmount()
  })
  it('keeps a safe 400 error retryable, but requires rereading after 409', async()=>{
    const f=fixture();await f.lifecycle.run(()=>Promise.reject({status:400,message:'PRIVATE RESPONSE'}),vi.fn())
    expect(f.lifecycle.error.value).not.toContain('PRIVATE RESPONSE');expect(f.lifecycle.locked.value).toBe(false)
    await f.lifecycle.run(()=>Promise.reject({status:409}),vi.fn());expect(f.lifecycle.locked.value).toBe(true);f.wrapper.unmount()
  })
  it('only unlocks the records actually returned by a successful read', async () => {
    const f = fixture()
    await f.lifecycle.run(() => Promise.reject({ status: 409 }), vi.fn())
    reconcileKnowledgeWrites('space-a', [{ itemKind: 'relationship', id: 'same' }])
    expect(f.lifecycle.locked.value).toBe(true)
    reconcileKnowledgeWrites('space-b', [{ itemKind: 'entity', id: 'same' }])
    expect(f.lifecycle.locked.value).toBe(true)
    reconcileKnowledgeWrites('space-a', [{ itemKind: 'entity', id: 'same' }])
    expect(f.lifecycle.locked.value).toBe(false)
    f.wrapper.unmount()
  })
})
