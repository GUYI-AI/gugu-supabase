# Gugu 基础后端

[English](README.md) | 简体中文

[咕咕](https://github.com/OpenDCAI/gugu) 的社区后端：身份、消息、同步、设备通信、权限和基础文件能力，运行在你自己的 Supabase 项目上。官方云托管、套餐、模型网关和支付由官方另行运营，不在开源范围内，社区安装也不需要它们。

本仓按修改版 Apache License 2.0 发布，见 [LICENSE](LICENSE)：个人自用和组织内部使用无需商业许可，对外提供多租户托管服务需取得商业许可；完整 Apache 2.0 文本见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。

## 在自己的 Supabase Cloud 中安装

从零开始的完整步骤（英文）：[docs/self-hosting.md](docs/self-hosting.md)；SMTP 配置：[docs/self-hosting-smtp.md](docs/self-hosting-smtp.md)；免费版限制与排错：[docs/self-hosting-free-plan.md](docs/self-hosting-free-plan.md)。

需要 Node 24、pnpm 10.28.2、自己的 Supabase 账号，以及一个全新的专用 Postgres 17 项目。

```sh
pnpm install --frozen-lockfile
# 在本机设置 SUPABASE_PROJECT_REF 和 SUPABASE_ACCESS_TOKEN；不要发到聊天或提交 Git。
pnpm run setup --client-dir /path/to/gugu
```

工具会检查项目为空，在一个事务里安装基线，再按顺序安装后续 release；然后配置 API schema、部署 server-login/attachments、设置附件回收任务，最后写入客户端 `.envs/local.env`。客户端文件只包含公共 URL 和 anon key；官方托管、官方模型和官方中转均关闭。模型在客户端配置你自己的 Claude 账号或 API。

重复运行只接受版本和摘要一致的安装；遇到不认识的 schema 或摘要不同的安装会拒绝，不删除数据，也不改写安装账本。SMTP 与项目管理由安装者负责；客户端靠邮件验证码登录，因此需要配置自己的 SMTP。

## 基线、增量与权限

- `supabase/migrations/20261021000000_foundation.sql` 是基线：包含 RLS、Auth 触发器、Realtime 授权、Storage 策略和三项维护任务，只用于新项目。
- 之后的每个 `supabase/migrations/<版本>_<名字>.sql` 是一个 release，按顺序安装并记入 `gugu_install.releases`。除显式校验摘要的[工作区索引拆分](docs/concurrent-index-releases.md)外，已发布的文件不再修改，改动一律发新文件。
- 新建的 API 函数默认禁止客户端执行，由 release 显式授权。
- `identity.machine_limits_for(uuid)` 是安装策略接口，社区版使用安装级配置。设备所有权、群成员、消息与文件权限都由数据库判定。

## 文件服务

附件上传、提交与签名下载使用你自己的 Supabase Storage。

协同文件编辑需要另外运行 `services/files` 的 Node 常驻服务，Supabase Cloud 不会替你运行它。服务使用独立的 `gugu_files` 数据库角色、项目 JWKS 和 HTTPS/WebSocket 入口，配置见 `services/files/src/config.mjs` 与 `docs/files-service.md`。

## 本地验证

在一台有 Docker 的开发机上运行：

```sh
pnpm test:db:start
export GUGU_INSTALL_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable'
export GUGU_INTEGRATION_DATABASE_URL="$GUGU_INSTALL_TEST_DATABASE_URL"
pnpm test:installation
pnpm test
pnpm test:integration
pnpm test:db:stop
```

`GUGU_TEST_DB_PORT` 可指定未占用端口。脚本只管理本 checkout 标记的测试项目，数据库只绑定回环地址；stop 会删除这个一次性测试库的卷。安装测试必须使用空库。

客户端仓的 `supabase-contract` 测试项目会连接这个测试库，验证客户端与后端的契约。
