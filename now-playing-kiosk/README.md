# Now Playing на экране Raspberry Pi

Пакет 0.1.1 для официального Now Playing 1.0.6. Киоск открывает `http://localhost:4004`.
Изменения используют Rotary Encoder II 2.2.1 и Artwork One для локального файлового кэша.
Качество потоков требует обновления Яндекс Музыки и Qobuz Custom до 0.3.2 их штатными пакетами.
При управляемом аудиовыходе обновить Playback Engines до 0.1.5 перед установкой.

## Сборка

Запустить `./now-playing-kiosk/build.sh` на машине с Git, Node.js 20+ и Python 3.
Скрипт собирает архив и SHA-256 в `now-playing-kiosk/dist/`. Версии и ревизии
закреплены в [base.env](base.env), изменения лежат в [patches](patches).

## Установка и повторное применение

Передать архив на Pi, распаковать и выполнить из каталога `now-playing-kiosk`:

```sh
sudo python3 install.py check
sudo python3 install.py install
```

Установка перезапускает Volumio и Chromium на HDMI. Сохранённые параметры
Now Playing остаются в `/data/configuration/user_interface/now_playing`.
Четыре сохранённых действия энкодера и снимки файлов лежат в `/data/now-playing-kiosk`.
Повторный запуск `install` проверяет установленный пакет.

Перед штатным обновлением Now Playing выполнить `sudo python3 install.py restore`.
После официального обновления установить пакет, собранный для новой версии.
Для новой базы обновить ревизии в `base.env`, перенести патчи, пересобрать и прогнать
[приёмку](../docs/superpowers/specs/2026-11-24-now-playing-kiosk.md#приёмка-на-raspberry-pi).
`sudo python3 install.py rollback` восстанавливает предыдущий киоск-пакет для
текущей официальной базы. `restore` возвращает официальные файлы и действия энкодера.
