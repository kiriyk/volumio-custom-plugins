# Volumio: Яндекс Музыка, Qobuz и Artwork One

Плагины для Volumio 4 на Raspberry Pi: источники Яндекс Музыки, Qobuz и адаптированный
интерфейс Artwork One. Проверено на Volumio 4.239 / Bookworm, Raspberry Pi 4,
32-битном userspace armhf. Совместимость с другими сборками не гарантируется.

- [Яндекс Музыка](yandex-music/README.md): авторизация, поиск, коллекция,
  плейлисты, страницы исполнителей и воспроизведение MP3 или FLAC.
- [Qobuz Custom](qobuz/README.md): независимый плагин 0.1.0, браузерный вход,
  поиск треков и альбомов, любимые альбомы и воспроизведение FLAC. Нужна подписка Qobuz.
- [Artwork One](artwork-one/README.md): тема на основе проекта
  [michaltamas/volumio-artwork-one](https://github.com/michaltamas/volumio-artwork-one)
  с поиском и навигацией Яндекса/Qobuz, крошками и данными качества аудио.
- [Восстановление](yandex-music/docs/RECOVERY.md): установка на новую прошивку,
  резервирование и необязательное исправление ошибки обнаружения Volumio.
- [Готовые архивы](packages/): собранные версии плагинов, без токенов.

Монорепозиторий начат со снимков двух локальных репозиториев: Яндекс-плагин
`6c53ed3` и адаптация Artwork One `905d562`; последующие изменения, Qobuz и обход
высокой загрузки CPU сохранены отдельными коммитами здесь. История исходного проекта темы
и права её авторов сохраняются; лицензии и уведомления находятся внутри каждого
каталога. Обновление официальной темы может заменить наши изменения.

## Установка из исходников

```bash
git clone https://github.com/kiriyk/volumio-custom-plugins.git
cd volumio-custom-plugins/yandex-music
bash scripts/deploy.sh volumio@volumio.local
```

Включите установленный плагин, затем войдите в Яндекс Музыку по коду в его
настройках. Для установки требуются доступ к сети и подтверждение CLI Volumio.
Инсталлятор может установить системные зависимости, включая `ffmpeg`.

## Установка из готовых архивов

Из каталога клонированного репозитория на компьютере:

```bash
scp packages/yandex_music-0.2.1.tar.gz packages/artwork-one.tar.gz artwork-one/scripts/install.sh volumio@volumio.local:/tmp/
ssh volumio@volumio.local
```

На плеере:

```bash
mkdir -p /tmp/yandex-music-install
tar -xzf /tmp/yandex_music-0.2.1.tar.gz -C /tmp/yandex-music-install
cd /tmp/yandex-music-install/yandex_music
volumio plugin install
bash /tmp/install.sh --from /tmp/artwork-one.tar.gz --activate
```

Установщик темы перезапустит Volumio. После установки плагин нужно включить и
авторизовать. Пользовательские учётные данные и файлы музыки в репозиторий не
входят. Доступность FLAC зависит от аккаунта и конкретного трека; API Яндекса
неофициальный и может измениться.

Для Qobuz аналогично перенести `packages/qobuz_custom-0.1.0.tar.gz`, распаковать
и выполнить `volumio plugin install` в каталоге `qobuz_custom`, затем включить
**Qobuz Custom** и пройти вход в его настройках. Обновление: `node scripts/update.js .`;
полное удаление стирает сессию. Подробности и ограничения — в [README плагина](qobuz/README.md).
