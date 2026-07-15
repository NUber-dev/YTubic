# Идеи и улучшения из форков

Снимок fork-сети `NUber-dev/YTubic` от 15 июля 2026 года. Это список идей для последующего разбора, а не готовый план слияния: крупные ветки конфликтуют с `main`, поэтому изменения следует переносить небольшими тематическими коммитами с тестами.

## Платформы

- Linux: `.deb`/`.rpm`/AppImage, CI-релизы, resize frameless-окон и защищённое хранение cookie через Secret Service. Уже адаптировано в локальной Linux-ветке на основе PR #1.
- macOS: native title bar, Keychain + AES-GCM для cookie, Safari UA для login WebView, universal Intel/Apple Silicon build, Dock/menu bar и системные медиакнопки. PR #27 выглядит наиболее сфокусированной основой; из draft PR #33 стоит брать отдельные улучшения.

## Плеер

- Сохранять последний трек и playhead, восстанавливать их после перезапуска (`ameenalasady`, `5510d22`).
- Восстанавливать последнюю страницу и scroll position (`ameenalasady`, `f41d57f`).
- Исправить двойную длительность некоторых потоков на macOS и некорректный seek до загрузки metadata.
- Добавить fallback между yt-dlp clients (`android_vr`, `ios`) при DRM/403 и fallback с video на audio.
- Сделать Song/Video настоящим переключением audio/video stream, включая отдельный video cache.
- Осторожно пропускать длинные пустые outro в extended uploads.
- Добавить полноэкранный плеер с крупной обложкой, lyrics, ambient-фоном и accent color.

## Lyrics

- Добавить таймауты провайдеров, чтобы панель не зависала на Loading.
- Строже отбрасывать lyrics от другой песни: учитывать исполнителя, длительность и remix/live qualifiers.
- Масштабировать timestamps для sped-up/slowed версий и поддержать ручной offset на трек.
- Разрешить глобально отключать lyrics и не выполнять сетевые запросы (`ameenalasady`, `022ab82`).
- Показывать queue вместо пустого состояния, если lyrics отсутствуют.

## Библиотека и навигация

- Для Library → Songs использовать `FEmusic_liked_videos`, а не общий `LM`, куда могут попадать Shorts и обычные YouTube-видео.
- Не включать Suggested tracks в настоящее содержимое плейлиста.
- В поиске открывать album/artist/playlist страницы, а не запускать случайный video из play overlay.
- Улучшить shuffle исполнителя: полный каталог, новая последовательность при каждом запуске и продолжение станции.
- Сделать исполнителей и альбомы кликабельными из карточек и плеера.
- Использовать channel handle для дедупликации аккаунтов, когда YouTube не возвращает email.

## UI и настройки

- Добавить refresh Home и опциональную перестановку секций. Перестановку проектировать без обязательной eager-загрузки всего feed.
- Добавить поиск по музыкальному кэшу и показывать настоящие названия/исполнителей.
- Добавить lightbox для полноразмерной обложки; переносить вместе с последующими исправлениями выбора изображения.
- Изменяемые размеры sidebar/player, IndexedDB для активно меняющихся кэшей, ограничение cover cache и удаление auto-dock уже реализованы локально.

## Интеграции и авторизация

- Рассмотреть импорт cookie из браузеров как отдельный fallback для сломанного WebView login, только после security review.
- Brand channel switching уже есть в основном приложении; старую реализацию переносить не нужно.
- Проверить, полностью ли перенесены Last.fm offline retry, очистка `Topic` и avatar account card.

## Не переносить

- Пользовательский или включённый по умолчанию обход Premium gate.
- Изменение, которое распознаёт Premium upsell как наличие Premium.
- Updater public keys из чужих форков.
- Целые конфликтующие macOS/auth ветки без разбиения и платформенных regression-тестов.

## Источники

- PR #1: <https://github.com/NUber-dev/YTubic/pull/1>
- PR #3: <https://github.com/NUber-dev/YTubic/pull/3>
- PR #27: <https://github.com/NUber-dev/YTubic/pull/27>
- PR #33: <https://github.com/NUber-dev/YTubic/pull/33>
- Ameen fork: <https://github.com/ameenalasady/YTubic>
- YTMac fork: <https://github.com/metabreakr/YTMac>
