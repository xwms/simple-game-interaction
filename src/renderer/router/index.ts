/**
 * 功能描述：Vue Router 配置
 *
 * 逻辑说明：定义八个路由页面：首页、创建房间、加入房间、房间内、设置、日志、关于、404。
 *           使用路由懒加载（动态 import）。注册路由守卫验证房间状态。
 *           meta.index 用于确定页面切换的滑动方向。
 */

import { createRouter, createMemoryHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useRoomStore } from '../store/room'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: 'nav.home', index: 0 }
  },
  {
    path: '/host',
    name: 'host',
    component: () => import('../views/HostView.vue'),
    meta: { title: 'nav.host', index: 1 }
  },
  {
    path: '/join',
    name: 'join',
    component: () => import('../views/JoinView.vue'),
    meta: { title: 'nav.join', index: 1 }
  },
  {
    path: '/room/:roomCode',
    name: 'room',
    component: () => import('../views/RoomView.vue'),
    meta: { title: 'nav.room', index: 2 }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: 'nav.settings', index: 1 }
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('../views/LogView.vue'),
    meta: { title: 'nav.logs', index: 1 }
  },
  {
    path: '/about',
    name: 'about',
    component: () => import('../views/AboutView.vue'),
    meta: { title: 'nav.about', index: 1 }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: { title: '404', index: 99 }
  }
]

export const router = createRouter({
  history: createMemoryHistory(),
  routes
})

// 路由守卫：未加入房间时禁止访问 /room/:roomCode
router.beforeEach((to, _from, next) => {
  if (to.name === 'room') {
    const roomStore = useRoomStore()
    if (!roomStore.roomCode) {
      next({ name: 'home' })
      return
    }
  }
  next()
})
