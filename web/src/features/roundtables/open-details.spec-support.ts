import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'

// Who is in an open conversation is shown in its 详情 dialog (RoundtableChatHead.vue),
// which renders outside the component: open it and read what it shows.
export async function openDetails(wrapper: Pick<VueWrapper, 'get'> | Pick<DOMWrapper<Element>, 'get'>) {
  await wrapper.get('[data-roundtable-details]').trigger('click')
  await flushPromises()
  const dialog = document.querySelector('[data-roundtable-details-dialog]')
  if (!dialog) throw new Error('The details dialog did not open')
  return {
    seats: [...dialog.querySelectorAll('[data-roundtable-seat]')].map(seat => new DOMWrapper(seat)),
    faces: [...dialog.querySelectorAll('.roundtable-seat-face img')].map(image => image.getAttribute('src')),
  }
}
