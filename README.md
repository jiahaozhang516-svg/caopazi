# caopazi（草爬子）

给 DeepSeek Harness（DSHM 端侧）用的插件：**南林 ACM AI Hub 每日签到 + 图书馆座位预约**，带设置页与完成度水晶角标。

> Daily check-in for NJFU's ACM AI Hub plus library seat booking, with a settings page and a progress badge. Both site addresses are fixed to Nanjing Forestry University; built for DSHM.

## 它做什么

| 任务 | 站点 | 方式 |
| --- | --- | --- |
| AI Hub 每日签到 | <https://acm.njfu.edu.cn/aihub/> | 企业微信扫码 OAuth 拿 `sid` Cookie，到点 `POST /api/checkin` 领当天额度 |
| 图书馆抢座 | <https://libseat.njfu.edu.cn> | 站点已改成 CAS 单点登录：全自动走 CAS 换 `ic-cookie`，每天 07:00 抢次日座位 |

两件事互不影响：签到和抢座各有一个定时器，抢座失败不会拖累签到。

## 安装

插件通过 profile 的 `dsh.profile.bundles` 注册，源码放在 `profiles/ondevice/plugins/caopazi`：

```jsonc
// profiles/ondevice/package.json
{
  "dependencies": { "caopazi": "file:./plugins/caopazi" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "caopazi"] } }
}
```

改完重启 DSHM。`cordis.patch.yml` 只有一行 `insert: id caopazi, name caopazi`；前端半（`lib/client.js`）由 `package.json` 的 `dsh.client` 声明加载。

## 工具（模型侧可调用）

| 工具 | 作用 |
| --- | --- |
| `aihub_checkin` | 立即签到（先查 `/api/me`，已签就跳过） |
| `aihub_status` | 开关、时间、登录态（脱敏）、今日是否已签到、最近记录 |
| `aihub_config` | 改每日时间 / 开关 / Cookie |
| `aihub_login_start` | 生成企业微信登录二维码（约 8 分钟有效） |
| `aihub_login_finish` | 长轮询等扫码结果并完成登录 |
| `seat_status` | 抢座配置与最近一次结果 |
| `seat_config` | 改开关、开抢时间、学号密码、区域、优先座位、兜底规则、时段、提前天数 |
| `seat_preview` | 演练：算出会抢哪个座位、用什么时段（可只算某天窗口，不联网） |
| `seat_book` | 立刻按当前配置抢一次（不等 07:00） |
| `seat_cancel` | 取消预约（传 `resvId` + `uuid`；不传则用最近一次成功记录） |

## 扫码登录（一台手机即可）

1. 调 `aihub_login_start`，二维码写到 `$DSH_HOME/aihub-checkin/login-qr.png`；
2. 存到相册（截图或从文件管理打开）；
3. 企业微信 → 扫一扫 → 右上角「相册」→ 选这张图 → 点「确认登录」；
4. 插件后台自动收尾（也可以 `aihub_login_finish`）。

登录成功后 Cookie 存在 `store.json`，之后不再需要扫码，直到服务端让会话过期。

## 抢座规则

- 每天 **07:00** 放「次日」的号；某天的座位只能在该天 07:00 之后订，不在窗口内会被服务端拒绝。
- 先按 `preferred` 顺序挑空位；都没有就按兜底规则（尾数奇偶、就近 N 格、或随便一个）。
- 座位对象自带当天 `openStart`/`openEnd`，下单前**自动裁剪**——周五 20:00 闭馆时不会去订 22:00。
- 「特殊时段」按周几覆盖，例如 `4=10:00-22:00` 表示周四只订 10:00 起。
- 开抢后前 3 分钟每 20 秒一发，之后退回 60 秒；业务拒绝（时段冲突）当天停手，鉴权失败连 3 次熔断。

> 座位生效后，站点要求**31 分钟内签到**，否则记违约 1 次且座位不保留——这一步插件不做，需要你本人到馆/在图书馆 App 里签。

## 设置页

「设置 → CaoPazi」可以改：签到开关与时间；抢座开关、开抢时间、使用时段、特殊时段、优先座位、兜底规则。保存走 `POST /aihub-checkin/config`，立即生效、不需要重启。

`manualCheckin`（纯手动模式：只提醒不提交签到）没有做进设置页，需要时直接改 `store.json` 的 `settings.manualCheckin`。

## 水晶角标

侧栏底部（「设置」左边）一枚 14×14 像素水晶，每 60 秒轮询 `GET /aihub-checkin/status`（只监听本机回环；界面关掉就不发请求）。

点亮档位按**已启用任务**的完成度：`0` 不亮 → `1/3` → `1/2` → `2/3` → 全亮。

| 情况 | 样子 |
| --- | --- |
| 全部完成 + 签到成功 + 抢到**首选座**（`preferred[0]`） | 全绿 + 四角闪光（0.7s 交替） |
| 全部完成 + 抢到**备选座** | 全亮，左半绿右半黄 |
| 只抢到备选座、签到没完成 | 按完成度亮，**全黄** |
| 登录态过期 | 琥珀色 |
| 其他部分完成 | 按完成度亮，绿色 |

悬停标题会写清「已完成 x/y」和两项任务的具体状态。

### 角标出问题时怎么关掉（不用重装）

在文件管理里 `Download/com.dshm.dshclient/` 下新建空文件 `aihub-badge-off`，重启两次：第一次启动时插件会摘掉自己 `package.json` 里的 `dsh.client`，第二次就不再加载前端半。进程内的签到/抢座不受影响。

## 数据与存储

- `$DSH_HOME/aihub-checkin/store.json`：配置、AI Hub Cookie、座位会话（`ic-cookie`）、最近 40 条记录
- `$DSH_HOME/aihub-checkin/login-qr.png`：登录二维码

## 边界（实话）

- 定时器只在 DSHM 进程活着时走；**应用被杀/被系统冻结时不会执行**。下次打开会补签当天，但抢座窗口过了就没了。
- 站点会随机给签到加腾讯 TCaptcha（要 `{ticket, randstr}`），脚本过不了。插件会记 `need-verify`、当天停手，并把角标提示改成「需要人工验证」。
- 座位会话就是 `ic-cookie` 一个 Cookie，由服务端决定寿命；过期后插件会自动重走 CAS，CAS 也失败时记一次「登录失败」并熔断当天。
- 校园网 IPv6 的 AAAA 记录连不通（443 refused）。插件用 undici `Agent({ connect: { family: 4 } })` 强制 IPv4 出站，避免 `connect ECONNREFUSED 2001:da8:…` 把请求全挂掉。
- 不修改站点、不代理流量；站点侧的 CSRF 校验要求请求来自本站，所以插件用原生 HTTP 直连（不带 `Origin` 头）。

## 接口备忘（2026-11 真机实测）

```
GET  /aihub/api/me                     → 200 {checkin:{doneToday,streak,nextReward,…}} / 401
POST /aihub/api/checkin  {}            → 200 {reward,streak}
GET  /ic-web/auth/address?finalAddress=…&manager=false   → 服务端签发 uuid，给出登录地址
GET  /ic-web/reserve?roomIds=…&resvDates=YYYYMMDD&sysKind=8   → 座位表（含 openStart/openEnd）
POST /ic-web/reserve/seat              → {uuid,resvId}（需 RSA/AES 加密字段）
POST /ic-web/reserve/delete            → {ok}（uuid + resvId 都要带）
GET  /ic-web/reserve/resvInfo?sysKind=8&beginDate=…&endDate=…  → 我的预约列表
```

## 停用 / 卸载

从 `dsh.profile.bundles` 里删掉 `caopazi`（以及 `dependencies` 里那行）后重启；数据目录 `$DSH_HOME/aihub-checkin/` 可一并删除。只想关角标就建 `aihub-badge-off` 文件。

## License

MIT
