import { expect, test } from 'claude-code/testing'


test('draws the closed band with an open button on the terminal', async ($, on) => {
  // Stands for the engine and the other mods beneath the switcher in the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="other" />
  })

  const mounted = await $.ui.mount({
    plugin: 'plugin-switcher',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  })

  expect(await mounted.find({ key: 'open' })).toBeDefined()
  expect(await mounted.find({ key: 'other' })).toBeDefined()
  await mounted.unmount()
})
