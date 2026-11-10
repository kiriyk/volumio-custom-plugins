# Восстановление на новой Volumio

Комплект рассчитан на Volumio 4 / Bookworm с Node.js >=20, Python >=3.11 и
пользовательской архитектурой armhf или amd64. Совместимость с другими версиями
прошивки не проверена. Храните комплект на устройстве отдельно от SD-карты плеера
и компьютера, с которого выполняется установка.

В комплекте:

- `yandex_music-0.2.1.tar.gz` — устанавливаемый плагин Яндекс Музыки;
- `artwork-one.tar.gz` и `artwork-install.sh` — собранная **наша** версия темы
  Artwork One и установщик, способный установить локальный архив;
- `yandex-source.tar.gz` и `artwork-source.tar.gz` — исходники с нашими
  изменениями. Git bundle при наличии содержит историю коммитов;
- `repair-volumio-discovery.py` — отдельная утилита восстановления исправления
  ошибки D-Bus в Volumio 4.239. Это изменение прошивки, а не плагин;
- `SHA256SUMS` — контрольные суммы; `PROJECT_HANDOFF.md` — состояние проекта.

Архивы не включают сохранённый вход или плейлисты пользователя. На новой
установке потребуется снова войти в Яндекс Музыку. Для установки системных и
Python-зависимостей требуется интернет; `ffmpeg` добавляется при отсутствии.
Плейлисты и локальные файлы следует резервировать отдельно.

## Установка

На компьютере в распакованном комплекте проверьте контрольные суммы:

```bash
sha256sum -c SHA256SUMS
```

Включите SSH в `http://volumio.local/dev`, затем передайте архивы и утилиты:

```bash
scp yandex_music-0.2.1.tar.gz artwork-one.tar.gz artwork-install.sh repair-volumio-discovery.py volumio@volumio.local:/tmp/
ssh volumio@volumio.local
```

На плеере выполните:

```bash
mkdir -p /tmp/yandex-music-install
tar -xzf /tmp/yandex_music-0.2.1.tar.gz -C /tmp/yandex-music-install
cd /tmp/yandex-music-install/yandex_music
volumio plugin install
```

Подтвердите ручную установку в CLI. Включите плагин в Volumio и войдите в
аккаунт. Затем установите нашу тему из локального архива:

```bash
bash /tmp/artwork-install.sh --from /tmp/artwork-one.tar.gz --activate
```

Установщик темы перезапустит Volumio. Доработки темы интегрируются с нашим
плагином: он должен оставаться включён для отображения характеристик файлов.
Не используйте установку последней upstream-версии вместо этого архива: в ней
нет наших изменений.

## Исправление Volumio Discovery

Применять **только если проблема повторилась** и проверена совместимость с
прошивкой. Утилита проверяет точную форму проблемного метода и не меняет
неизвестный код. Она сохраняет оригинал в `/data/volumiodiscovery-index-before-dbus-fix.js`,
отказывается перезаписывать существующую копию и не перезапускает сервис сама:

```bash
sudo python3 /tmp/repair-volumio-discovery.py
sudo systemctl restart volumio
```

Откат на этой установке, если сохранённая копия соответствует текущей версии
прошивки:

```bash
sudo cp /data/volumiodiscovery-index-before-dbus-fix.js /volumio/app/plugins/system_controller/volumiodiscovery/index.js
sudo systemctl restart volumio
```

После обновления прошивки сначала проверьте версию исходного файла: старую
резервную копию нельзя автоматически считать подходящей для новой прошивки.
Ни приложение исправления, ни откат сами по себе не устраняют причину ошибок DNS.

## Высокая загрузка CPU в Node.js на Raspberry Pi

На проверенной Volumio 4.239 с Node 20.5.1 / libuv 1.46.0 и armhf наблюдалась
постоянная загрузка одного ядра в цикле epoll/io_uring. Отключение io_uring
для одного сервиса снизило загрузку в коротком замере; это обходной путь для
данного окружения, а не гарантия для всех версий. На новой прошивке применяйте
его, только если проблема воспроизводится и системный drop-in не конфликтует с
вашей настройкой. После распаковки плагина в `/tmp/yandex-music-install`:

```bash
sudo install -D -m 644 /tmp/yandex-music-install/yandex_music/systemd/volumio-no-io-uring.conf /etc/systemd/system/volumio.service.d/90-no-io-uring.conf
sudo systemctl daemon-reload
sudo systemctl restart volumio
```

Откат: удалите только `/etc/systemd/system/volumio.service.d/90-no-io-uring.conf`,
затем выполните `sudo systemctl daemon-reload` и `sudo systemctl restart volumio`.
