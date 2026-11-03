# 草爬子 v2.0 —— AI Hub 签到 + 图书馆抢座

> 适用：DeepSeek Harness Mobile（DSHM）端侧，构建版本 `0.2.1-rc.x` 附近
> 站点：<https://acm.njfu.edu.cn/aihub/>（签到）· <https://libseat.njfu.edu.cn/>（图书馆座位）

一个插件干两件事：

| 任务 | 默认时间 | 做什么 |
| --- | --- | --- |
| **AI Hub 签到** | 每天 07:00 | 自动签到的额度，连续天数自动累积 |
| **图书馆抢座** | 每天 07:00 | 抢**次日**三层B区的座位，按你给的优先级挑，失败按规则兜底 |

侧栏底部有一枚像素水晶，按「已完成任务数 / 总任务数」逐级点亮；设置里有一个「草爬子」页，
两个任务各自独立开关、各自设时间。

---

## 一、你要做的（人工 3 步）

1. 把整个文件夹（或 zip 解压后的目录）放进设备的 `Download/` 里；
2. 打开 DSHM，对助手说：**「把 Download 里的 aihub-checkin 装上，按 INSTALL.md 做」**；
3. 助手装完会让你**重启一次应用**。

重启后：

4. **设置 → 草爬子** → 填图书馆学工号、密码（图书馆借阅系统的密码，不是统一身份认证的），
   填目标座位、时段，点保存；
5. 对助手说**「登录 aihub」**，用企业微信扫它给的二维码（这一步是 AI Hub 签到用的，图书馆不需要）。

---

## 二、给 AI 助手的执行步骤

### 0. 确认环境

```sh
echo "$DSH_HOME"
ls "$DSH_HOME/profiles"
```

### 1. 运行安装脚本

```sh
cd <解压后的目录>
DSH_HOME="$DSH_HOME" sh install.sh
```

脚本会：复制 5 个文件到 `<profile>/node_modules/aihub-checkin`；往 `$DSH_HOME/cordis.patch.yml`
追加 `insert` 行（已存在则跳过，改前备份）；把属主改回 profile 属主。

**失败时的手工等价操作**：

```sh
PROFILE=$(ls -d "$DSH_HOME"/profiles/*/ | head -n1)
mkdir -p "$PROFILE/node_modules/aihub-checkin/lib"
cp index.js libseat.js package.json README.md "$PROFILE/node_modules/aihub-checkin/"
cp lib/client.js "$PROFILE/node_modules/aihub-checkin/lib/"
# 然后往 $DSH_HOME/cordis.patch.yml 追加（文件不存在就新建）：
# - insert:
#     - id: aihub-checkin
#       name: aihub-checkin
```

### 2. 重启应用

必须重启：宿主插件在启动时挂载，前端包在启动时组合。

### 3. 首次配置

AI Hub 需要扫码（企业微信）：

```
aihub_login_start  → 生成二维码 PNG
publish 那个 PNG    → 用户「企业微信 → 扫一扫 → 相册 → 选图 → 确认」
aihub_login_finish → 收尾并保存会话
```

图书馆只需要账号密码，在 **设置 → 草爬子** 里填，或让助手调：

```
seat_config user=... pass=... preferred=["3F-B004","3F-B010","3F-B002","3F-B011"]
```

### 4. 验证

```
seat_preview    # 演练：算出明天会抢哪个座、为什么（不下单）
seat_status     # 配置 + 最近结果
aihub_status    # 签到状态 + 角标接口自检（应为 HTTP 200）
```

`seat_preview` 返回类似「演练：将预约 3F-B004（目标座位 3F-B004 空闲）」即为正常。

---

## 三、角标规则

侧栏底部的水晶按完成度点亮（`a` = 已完成任务数，`n` = 已启用任务数）：

| 情况 | 点亮 |
| --- | --- |
| a = 0 | 不亮 |
| 0 < a/n < 0.5 | 1/3 |
| a/n = 0.5 | 1/2 |
| 0.5 < a/n < 1 | 2/3 |
| a/n = 1 | 全亮（描边也转绿） |

悬停显示「已完成 a/n」。以后加新任务，`n` 自动变大，档位照旧。

## 四、怎么改成别的区域

默认 `roomId = 100455352`（图书馆三层B区）。要换区域，在电脑端进那个区域，
地址栏是 `/#/ic/seatPredetermine/<roomId>`，把最后那串数字填进设置里的区域 id 即可。

---

## 四点五、特殊时段（某天不想按默认时段）

设置里「特殊时段」一栏，写法是 `星期=开始-结束`，多条用分号隔开：

- `4=10:00-22:00` —— 每周四只订 10:00 起（因为早上有课）
- `4=10:00-22:00;6=09:00-18:00` —— 周四 + 周六各一条

星期编号：`0=周日 1=周一 2=周二 3=周三 4=周四 5=周五 6=周六`。

它在「默认时段」之上覆盖，之后还会被**当天实际闭馆时间**再裁一次（例如周五 20:00 闭馆，
即使写 22:00，最终也只订到 20:00）。只算窗口、不联网、没放号也能算：

```
seat_preview date=2026-11-06
```

## 五、边界（实话）

- **定时器只在 DSHM 进程活着时跑**。应用被杀/被冻结就不执行；签到会补，**抢座不补**
  （号早放完了，补也没用）。
- 图书馆有反爬：短时间内十几次请求后整站会 403 几分钟。插件已经做了缓存（公钥 10 分钟、
  座位表 45 秒）和节流（开抢后 3 分钟内 20 秒一发，之后 60 秒），别手动狂点。
- **预约成功后 31 分钟内必须到馆签到**，否则记违约、座位释放。
- 会话过期：AI Hub 会提示「登录已过期」，重新扫码；图书馆密码改了要去设置里同步改。

## 六、出问题

| 现象 | 处理 |
| --- | --- |
| 设置里没有「草爬子」 | 确认 patch 里有 `aihub-checkin` 行，重启应用 |
| 水晶不显示 | 前端包没加载；`aihub_status` 的「角标接口」若为 200，说明只是前端问题 |
| 抢座失败 | 看 `seat_status` 的「最近一次」；`座位表为空` = 还没放号；`当前时段有预约` = 已有冲突订单 |
| 界面异常 | 在 `Download/com.dshm.dshclient/` 建空文件 `aihub-badge-off`，重启两次即摘掉前端 |

## 七、卸载

```sh
DSH_HOME="$DSH_HOME" sh uninstall.sh
```

删目录 + 从 patch 摘掉 insert 行（改前备份），重启生效。
数据目录 `$DSH_HOME/aihub-checkin/` 可手动删。
