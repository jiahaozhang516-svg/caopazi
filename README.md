# aihub-checkin —— 南林 ACM「AI Hub」每日自动签到

给 DeepSeek Harness（DSHM 端侧）用的 Cordis 插件。装好之后，手机会在**每天 08:00（Asia/Shanghai）**
自动到 <https://acm.njfu.edu.cn/aihub/> 签到，领取当天额度；应用被杀错过时间的话，下次启动会补签一次。

## 它做了什么

| 环节 | 实现 |
| --- | --- |
| 登录 | 企业微信扫码 OAuth：`/api/auth/login` → `getWebQrCodeKey` → 二维码 → `getWebQrCodeStatus` 长轮询 → `auth_code` → `/api/auth/callback` 换会话 Cookie（`sid`） |
| 签到 | `GET /api/me` 判断 `checkin.doneToday`，未签到则 `POST /api/checkin`（body `{}`） |
| 定时 | 进程内 60 秒一跳；到点且今天没签就签；启动 8 秒后补一次 |
| 存储 | `$DSH_HOME/aihub-checkin/store.json`（Cookie + 最近 40 条记录）、`login-qr.png`（扫码用） |

## 工具（模型侧可调用）

- `aihub_checkin` —— 立即签到（先查 `/api/me`，已签到会跳过）
- `aihub_status` —— 看开关、时间、登录状态（脱敏）、今日是否已签到、最近记录
- `aihub_config` —— 改每日时间 / 开关 / Cookie
- `aihub_login_start` —— 生成登录二维码（约 8 分钟有效）
- `aihub_login_finish` —— 长轮询等扫码结果并完成登录

## 扫码登录怎么操作（一台手机即可）

1. 让模型调用 `aihub_login_start`，它会把二维码写到 `$DSH_HOME/aihub-checkin/login-qr.png`；
2. 把这张图存到相册（截图或从文件管理打开）；
3. 企业微信 → 扫一扫 → 右上角「相册」→ 选那张二维码 → 手机上点「确认登录」；
4. 插件后台每 60 秒会自己收尾（也可以手动 `aihub_login_finish`）。

登录成功后 Cookie 存在 `store.json`，**之后不再需要扫码**，直到服务端让会话过期。

## 侧栏角标（前端插件）

侧栏底部（「设置」左边）有一枚 14×14 的**像素水晶**（7×7 像素图，深色描边 + 浅色内芯，
`crispEdges` + `pixelated`，整数倍缩放），每 60 秒向宿主问一次状态：

| 颜色 | 含义 |
| --- | --- |
| 绿色（描边 `#15803d` / 内芯 `#86efac`） | 今日已签到（`/api/me` 里 `checkin.doneToday === true`） |
| 灰色（描边 `#6b7280` / 内芯 `#d1d5db`） | 今日未签到，或还没到点 |
| 琥珀色（描边 `#b45309` / 内芯 `#fcd34d`） | 登录态过期（401），需要重新扫码 |
| 不显示 | 接口不可用（离线、插件未加载）；不会报错、不会挡路 |

实现要点：

- 前端半（`lib/client.js`）注册进 `sidebar.footer.action` 插槽；**每个插槽组件都有独立的
  `SlotErrorBoundary`**，它崩了只会让这个位置空着，不影响整页。
- 整个模块工厂 + `apply()` 都包了 `try/catch`，最坏情况是「什么都不注册」。
- 数据来自宿主新加的 `GET /aihub-checkin/status`（只监听本机回环），它每次现问一次
  `/api/me`，所以你在浏览器里手动签到，角标也会变绿。
- 角标只在界面打开时轮询，关掉界面不发请求。

### 角标出问题时怎么关掉（不需要重装）

在文件管理的 `Download/com.dshm.dshclient/` 里新建一个空文件 `aihub-badge-off`，然后重启两次
应用：第一次启动时插件会摘掉自己 package.json 里的 `dsh.client` 声明，第二次启动就不再加载
前端半。进程内的签到功能不受影响。

## 边界（实话）

- 定时器只在 DSHM 进程活着时走。**应用被杀/被系统冻结时不执行**；下次打开应用会补签当天。
- 会话 Cookie 由服务端决定寿命（`sid`，实测可用；过期后 `/api/me` 返回 401）。插件会把状态记成
  「登录态已失效」，重新扫码一次即可，不需要电脑。
- 不修改站点、不代理任何流量；站点侧的 CSRF 校验要求请求来自本站，所以本插件用原生 HTTP 客户端
  直连（不带 `Origin` 头）。
- 前端半使用冷加载：**改 `lib/client.js` 或首次加角标都要重启应用**，热重载不会换掉已缓存的模块。

## 停用 / 卸载

在 `$DSH_HOME/cordis.patch.yml` 里把 `aihub-checkin` 那一行改成 `disabled: true`（或删掉整个
insert 块），重启应用即可。数据目录 `$DSH_HOME/aihub-checkin/` 可一并删除。

## 接口备忘（2026-11-02 真机实测）

```
GET  /aihub/api/me                      → 200 {checkin:{doneToday,streak,nextReward,…}} / 401 请先登录
POST /aihub/api/checkin  {}             → 200 {reward,streak}
POST https://login.work.weixin.qq.com/wwlogin/monoApi/sso/login/getWebQrCodeKey
     form: agentid=1000276&appid=wwea1c6a035e0d9ec7&lang=zh&login_type=CorpApp
           &redirect_uri=https://acm.njfu.edu.cn/aihub/api/auth/callback&state=<state>&refresh_key=true
     → {"data":{"web_key":"…"}}
GET  https://login.work.weixin.qq.com/wwlogin/sso/qrcode?key=<web_key>   → image/png
POST …/getWebQrCodeStatus  form: webKey=&lastStatus=0&openDataSid=         → 长轮询
     → {"data":{"status":"QRCODE_SCAN_NEVER|ING|SUCC|FAIL|PC_BIND|ERR"}}（SUCC 时带 auth_code）
```
