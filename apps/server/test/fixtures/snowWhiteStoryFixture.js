const scene = (id, title, text, choices = []) => ({
  id,
  name: title,
  kind: 'scene',
  body: { title, text },
  ...(choices.length ? { choices: choices.map(([choiceId, label, toNodeId]) => ({ id: choiceId, text: label, toNodeId })) } : {})
})

const ending = (id, title, text) => ({ ...scene(id, title, text), kind: 'ending' })

const dwarves = ['doc', 'grumpy', 'happy', 'sleepy', 'bashful', 'sneezy', 'dopey']
const allDwarves = dwarves.map((id) => `dwarf-${id}`)

export const snowWhiteStory = {
  schemaVersion: '1.0',
  startNodeId: 'sw-01-palace',
  nodes: [
    scene('sw-01-palace', '魔镜与离宫', '白雪公主在王宫镜前察觉女王的嫉妒，披上旅行披风准备离开。', [['go', '走进森林', 'sw-02-route-choice']]),
    scene('sw-02-route-choice', '森林岔路', '森林里出现溪边远路和矿洞近路，白雪公主观察路牌与篮子。', [['stream', '沿溪边走', 'sw-03-stream-route'], ['mine', '绕过矿洞', 'sw-04-mine-route']]),
    scene('sw-03-stream-route', '溪边小路', '白雪公主沿溪边前行，看到远处小屋升起炊烟。', [['continue', '前往小屋', 'sw-05-cottage-arrival']]),
    scene('sw-04-mine-route', '矿洞入口', '白雪公主绕过明亮的矿洞入口，看见矿镐和通往小屋的脚印。', [['continue', '循着脚印前往小屋', 'sw-05-cottage-arrival']]),
    scene('sw-05-cottage-arrival', '敲响小屋的门', '白雪公主来到森林小屋，轻轻敲门并等待屋内回应。', [['enter', '等矮人回家', 'sw-06-seven-dwarfs']]),
    scene('sw-06-seven-dwarfs', '七个矮人回家', '白雪公主在餐桌旁认识七个刚从矿场回来的矮人，大家友好地互相介绍。', [['next', '第二天清晨', 'sw-07-vendor']]),
    scene('sw-07-vendor', '苹果商贩', '女王伪装成商贩站在门外，递给白雪公主一只红苹果。', [['accept', '接过苹果看看', 'sw-08-accept-apple'], ['refuse', '先拒绝并询问', 'sw-09-refuse-apple']]),
    scene('sw-08-accept-apple', '苹果上的暗纹', '白雪公主接过苹果，看见表面浮现暗纹，感到困倦；商贩的眼神变得紧张。', [['recover', '矮人及时赶回', 'sw-10-dwarfs-wake']]),
    scene('sw-09-refuse-apple', '按响门铃', '白雪公主没有接苹果，转身按响门铃呼叫屋内的矮人。', [['alert', '与矮人商量', 'sw-11-defense-plan']]),
    scene('sw-10-dwarfs-wake', '清醒过来', '七个矮人扶白雪公主坐下，发现苹果暗纹并递上清水；白雪公主恢复精神。', [['continue', '一起查明真相', 'sw-12-reveal']]),
    scene('sw-11-defense-plan', '共同制定办法', '白雪公主与七个矮人关好门窗，分工观察并一起制定安全应对办法。', [['continue', '等待商贩回来', 'sw-12-reveal']]),
    scene('sw-12-reveal', '认出女王', '商贩再次靠近，白雪公主认出魔镜挂坠；女王露出王冠，七个矮人守在白雪身旁。', [['decide', '向王国使者说明', 'sw-13-ending-choice']]),
    scene('sw-13-ending-choice', '白雪公主的决定', '白雪公主向王国使者说明女王的追逐已经停止，并决定如何开启下一段生活。', [['justice', '公开证据，恢复公正', 'sw-14-ending-justice'], ['new-life', '离开王宫，开始新生活', 'sw-15-ending-new-life']]),
    ending('sw-14-ending-justice', '恢复公正', '白雪公主公开证据，王国恢复公正；女王接受审判，矮人与白雪一起庆祝新的开始。'),
    ending('sw-15-ending-new-life', '森林里的新生活', '白雪公主与七个矮人修整小屋，女王离开王宫；大家各自选择新的生活。')
  ]
}

const sceneIds = snowWhiteStory.nodes.map((node) => node.id)
const dwarfSceneIds = ['sw-06-seven-dwarfs', 'sw-10-dwarfs-wake', 'sw-11-defense-plan', 'sw-12-reveal', 'sw-13-ending-choice', 'sw-14-ending-justice', 'sw-15-ending-new-life']

function character(id, name, presentIn, stateKeys) {
  return { id, name, category: 'character', sceneIds: presentIn, stateVariants: stateKeys.map((stateKey) => ({ stateKey })) }
}

function prop(id, name, presentIn) {
  return { id, name, category: 'prop', sceneIds: presentIn, stateVariants: [{ stateKey: 'default' }] }
}

export const snowWhitePlan = {
  assets: [
    character('snow-white', '白雪公主', sceneIds, ['palace-dress', 'travel-cloak', 'cottage-dress', 'recovered-dress']),
    character('queen', '女王', ['sw-01-palace', 'sw-07-vendor', 'sw-08-accept-apple', 'sw-09-refuse-apple', 'sw-12-reveal', 'sw-13-ending-choice', 'sw-14-ending-justice', 'sw-15-ending-new-life'], ['queen-crowned', 'apple-vendor-disguise']),
    ...dwarves.map((id) => character(`dwarf-${id}`, `矮人${id}`, dwarfSceneIds, ['mine-clothes', 'guard-vest'])),
    prop('magic-mirror', '魔镜', ['sw-01-palace', 'sw-12-reveal', 'sw-14-ending-justice']),
    prop('apple', '红苹果', ['sw-07-vendor', 'sw-08-accept-apple', 'sw-09-refuse-apple', 'sw-10-dwarfs-wake']),
    prop('basket', '商贩提篮', ['sw-07-vendor', 'sw-08-accept-apple', 'sw-09-refuse-apple']),
    prop('cottage-table', '小屋餐桌', ['sw-06-seven-dwarfs', 'sw-10-dwarfs-wake']),
    prop('lantern', '小屋灯笼', ['sw-06-seven-dwarfs', 'sw-11-defense-plan', 'sw-12-reveal']),
    prop('mine-pickaxe', '矿镐', ['sw-04-mine-route', 'sw-06-seven-dwarfs']),
    prop('doorbell', '小屋门铃', ['sw-05-cottage-arrival', 'sw-09-refuse-apple', 'sw-11-defense-plan'])
  ]
}

export const expectedDwarfIds = allDwarves
export const expectedDwarfSceneIds = dwarfSceneIds