import { createRouter, createWebHashHistory } from 'vue-router'
import ConsoleLayout from '../layouts/ConsoleLayout.vue'

const routes = [
  {
    path: '/',
    component: ConsoleLayout,
    redirect: '/dashboard',
    children: [
      {
        path: 'chat',
        name: 'Chat',
        component: () => import('../pages/ChatPage.vue'),
        meta: { title: '聊天', icon: '◉' }
      },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../pages/DashboardPage.vue'),
        meta: { title: '总览', icon: '□' }
      },
      {
        path: 'generators',
        name: 'Generators',
        component: () => import('../pages/GeneratorsPage.vue'),
        meta: { title: '生成工具', icon: '⚙' }
      },
      {
        path: 'agents',
        name: 'Agents',
        component: () => import('../pages/AgentsPage.vue'),
        meta: { title: '本地 Agent', icon: '◆' }
      },
      {
        path: 'projects',
        name: 'Projects',
        component: () => import('../pages/ProjectsPage.vue'),
        meta: { title: '项目', icon: '▣' }
      },
      {
        path: 'events',
        name: 'Events',
        component: () => import('../pages/EventsPage.vue'),
        meta: { title: '项目事件', icon: '✦' }
      },
      {
        path: 'sessions',
        name: 'Sessions',
        component: () => import('../pages/SessionsPage.vue'),
        meta: { title: '任务与会话', icon: '▶' }
      },
      {
        path: 'governance',
        name: 'Governance',
        component: () => import('../pages/GovernancePage.vue'),
        meta: { title: '治理', icon: '◈' }
      },
      {
        path: 'logs',
        name: 'Logs',
        component: () => import('../pages/LogsPage.vue'),
        meta: { title: '日志与诊断', icon: '≡' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../pages/SettingsPage.vue'),
        meta: { title: '设置', icon: '⚙' }
      },
      {
        path: 'workbench',
        name: 'Workbench',
        component: () => import('../pages/WorkbenchPage.vue'),
        meta: { title: '工作台', icon: '⌘' }
      }
    ]
  }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// 记住上次打开的页面：刷新后回到原页面，而不是每次都回默认页
const LAST_ROUTE_KEY = 'gamestudio.console.lastRoute'
let isInitialNavigation = true

router.afterEach((to) => {
  if (to.path && to.path !== '/') {
    try { window.localStorage.setItem(LAST_ROUTE_KEY, to.path) } catch { /* 存储不可用时忽略 */ }
  }
})

router.beforeEach((to) => {
  if (!isInitialNavigation) return true
  isInitialNavigation = false
  // 仅在落在默认入口（'/' 或其重定向目标 '/dashboard'）时才恢复上次页面
  if (to.path === '/' || to.path === '/dashboard') {
    try {
      const last = window.localStorage.getItem(LAST_ROUTE_KEY)
      if (last && last !== '/' && last !== '/dashboard' && last !== to.path) return { path: last }
    } catch { /* 存储不可用时忽略 */ }
  }
  return true
})

export default router
