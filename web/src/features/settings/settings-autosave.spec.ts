import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SAVED_NOTICE_MS, TEXT_SAVE_DELAY_MS, useSettingsAutoSave } from './settings-autosave'

// A synthetic settings value the person edits.
function setup({ ready = (): boolean => true, save = vi.fn(async (_value: { name: string }) => {}) } = {}) {
  const value = { name: 'Synthetic' }
  const scope = effectScope()
  const autoSave = scope.run(() => useSettingsAutoSave({ read: () => ({ ...value }), save, ready }))!
  autoSave.remember({ ...value })
  return { value, save, scope, autoSave }
}

describe('useSettingsAutoSave', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('waits for a pause in typing, then saves the last text once', async () => {
    const { value, save, autoSave } = setup()
    value.name = 'S'
    autoSave.changed('text')
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS - 100)
    value.name = 'Syn'
    autoSave.changed('text')
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS - 1)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith({ name: 'Syn' })
    expect(autoSave.state.value).toBe('saved')
  })

  it('saves a switch or a choice at once, and sends nothing when nothing changed', async () => {
    const { value, save, autoSave } = setup()
    autoSave.changed('choice')
    await vi.advanceTimersByTimeAsync(0)
    expect(save).not.toHaveBeenCalled()
    value.name = 'Switched'
    autoSave.changed('choice')
    expect(save).toHaveBeenCalledWith({ name: 'Switched' })
    expect(autoSave.state.value).toBe('saving')
  })

  it('shows 已自动保存 for a few seconds, then goes quiet', async () => {
    const { value, autoSave } = setup()
    value.name = 'Saved'
    autoSave.changed('choice')
    await vi.advanceTimersByTimeAsync(0)
    expect(autoSave.state.value).toBe('saved')
    await vi.advanceTimersByTimeAsync(SAVED_NOTICE_MS - 1)
    expect(autoSave.state.value).toBe('saved')
    await vi.advanceTimersByTimeAsync(1)
    expect(autoSave.state.value).toBe('idle')
  })

  it('sends a change made during a save right after it, never two at once', async () => {
    let finish!: () => void
    const save = vi.fn((_value: { name: string }) => new Promise<void>(resolve => { finish = resolve }))
    const { value, autoSave } = setup({ save })
    value.name = 'First'
    autoSave.changed('choice')
    value.name = 'Second'
    autoSave.changed('choice')
    expect(save).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({ name: 'Second' })
  })

  it('keeps the change and says why when the save fails, and sends it again on retry', async () => {
    const save = vi.fn(async (_value: { name: string }): Promise<void> => { throw new Error('Synthetic refusal') })
    const { value, autoSave } = setup({ save })
    value.name = 'Refused'
    autoSave.changed('choice')
    await vi.advanceTimersByTimeAsync(0)
    expect(autoSave.state.value).toBe('error')
    expect(autoSave.failure.value).toBe('Synthetic refusal')
    expect(value.name).toBe('Refused')
    save.mockResolvedValueOnce(undefined)
    autoSave.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({ name: 'Refused' })
    expect(autoSave.state.value).toBe('saved')
    expect(autoSave.failure.value).toBe('')
  })

  it('sends nothing while a field cannot be saved', async () => {
    const { value, save, autoSave } = setup({ ready: () => false })
    value.name = ''
    autoSave.changed('choice')
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS)
    expect(save).not.toHaveBeenCalled()
    expect(autoSave.state.value).toBe('idle')
  })

  it('sends a pending edit when the page goes away instead of dropping it', () => {
    const { value, save, scope, autoSave } = setup()
    value.name = 'Typed then left'
    autoSave.changed('text')
    scope.stop()
    expect(save).toHaveBeenCalledWith({ name: 'Typed then left' })
  })
})
