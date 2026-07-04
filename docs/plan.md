# План работ

Долгоживущий план, рассчитанный на несколько сессий. По мере работы над пунктом — раскрываем его подзадачами и отмечаем прогресс. Когда пункт закрыт, ставим `[x]` и при желании оставляем краткую заметку о том, что и где поменялось.

## Задачи

- [x] **1. Починить и дополнить Home Page**
- [x] **2. Добавить страницу Explore**
  - `src/lib/innertube/explore.ts` — общий browse-feed fetcher для `FEmusic_explore`, `FEmusic_charts`, `FEmusic_new_releases`, `FEmusic_moods_and_genres`, плюс `fetchMoodCategoryFeedPage(browseId, params, cursor)` для подстраницы конкретной категории.
  - `src/components/shared/feed-view.tsx` — общий шелл (заголовок + infinite shelves), `display === "grid"` переключает рендер на `ShelfGrid`.
  - `src/components/shared/shelf-grid.tsx` — адаптивная сетка `auto-fill minmax(14rem, 20rem)` для шелфов из `musicNavigationButtonRenderer`.
  - 5 роутов: `/explore` (с тремя горячими карточками-ссылками сверху), `/charts`, `/new-releases`, `/moods`, `/moods/$id` (последний — `moods_.$id.tsx` с trailing-`_` чтобы был flat, а не child `/moods`).
  - Парсер `mapNavigationButton` в `shared.ts` распознаёт цветные плитки-категории (`solid.leftStripeColor` → `tint`, `clickCommand.browseEndpoint.{browseId,params}`); тип `ShelfItem` расширен `kind: "category"`, `categoryParams`, `tint`; тип `Shelf.display` дополнен `"grid"`.
  - В сайдбар добавлен пункт Explore (`CompassIcon`) между Home и Search.
  - На `/explore` собственный fetcher отбрасывает шелфы с `display === "grid"` — top-buttons API-grid дублирует hard-coded карточки и не нужен.
  - В `shelf-card.tsx` для `kind === "category"` отрисовывается pill: цветной `border-l-4` (огибает `rounded-lg`), радиальное свечение из левого края, иконка из mapping `CATEGORY_ICONS` (Energize→Zap, Workout→Dumbbell, …) + `GEO_KEYWORDS`-эвристика → Globe; clickability через `Link to="/moods/$id"` с `search={{ p: categoryParams, t: title }}` чтобы заголовок подстраницы совпадал с названием плитки.
- [ ] **3. Исправить и улучшить страницу Search**
- [ ] **4. Исправить и улучшить страницу Library**
- [x] **5. Добавить Layout options для плеера**
  - `src/lib/store/layout.ts` — zustand-persist store с режимом `right | bottom | floating`, ключ `ytm-layout`.
  - `src/lib/floating-player.ts` — utility-флаги (`FLOATING_WINDOW_LABEL`, `FLOATING_QUERY_FLAG`, `isFloatingPlayerWindow()`).
  - `top-bar.tsx` — disabled пункт `Layout` заменён на `<DropdownMenuSub>` с тремя радио-опциями (Side card / Bottom bar / Floating window).
  - `app-shell.tsx` — режим-зависимая верстка: `right` оставляет `pr-[23rem]` + `<PlayerBar />`, `bottom` рендерит `<PlayerBarBottom />` сиблингом `<main>`, `floating` убирает inline-плеер и монтирует `<FloatingPlayerSync />`. Эффекты `invoke("open_player_window" | "close_player_window")` на смене mode + listener `player-window-closed` для авто-возврата в `right`, когда юзер закрывает плавающее окно.
  - `player-bar.tsx` — экспортирует переиспользуемые `ProgressSlider`, `VolumeControl`, `SourceToggle`, `useITunesCover`, `formatTime`. Принимает `variant?: "right" | "floating"` (отличаются только wrapper-стили).
  - `player-bar-bottom.tsx` — компактный horizontal bar 5rem высотой, sibling `<main>`, поэтому естественно ограничен сайдбаром слева. Лирика — `<Popover>` поверх mic-иконки (переиспользуем `LyricsBody` + `LyricsSourceButton` из `lyrics-view.tsx`).
  - `floating-player-app.tsx` — entry-point standalone-окна (`?floating-player=1`): `ThemeProvider` + `PersistQueryClientProvider` + `TooltipProvider` + кастомный titlebar (drag region + close → `invoke("close_player_window")`) + `<PlayerBar variant="floating">`. Audio engine не подключается, т.к. floating не рендерит `AppShell`.
  - `floating-player-sync.tsx` — `<FloatingPlayerSync>` (main-side) подписывается на `usePlaybackStore` / `useTrackSourceStore` через `subscribe()`, эмиттит `playback:state` / `track-source:state` на каждое изменение, слушает `playback:action` / `track-source:action` от плавающего окна и диспатчит к локальному store. На `playback:request-snapshot` — повторно эмиттит снапшот (для случая, когда floating-окно подключилось позже). `<FloatingPlayerSyncReceiver>` (floating-side) пингует snapshot на mount и мерджит входящий state в локальный store.
  - `playback.ts` / `track-source.ts` — после `create()` в floating-режиме переопределяют user-actions (`toggle/next/prev/seek/setVolume/toggleMute/setShuffle/cycleRepeat/goTo/removeAt/clearQueue/appendToQueue/setAutoRadio` + `setSelected/setAlternate`) на эмиттеры Tauri events. `seek`/`setVolume`/`toggleMute` дополнительно делают оптимистичный local-update, чтобы слайдер/иконка не дёргались на round-trip.
  - `App.tsx` — `if (isFloatingPlayerWindow()) return <FloatingPlayerApp />;` ветка ДО `RouterProvider`, т.к. floating-окно не имеет роутинга.
  - `jump-to-current-button.tsx` — `right`/`bottom` оффсеты pill адаптируются под mode: `right` остаётся `right: 23rem, bottom: 1rem`; `bottom` сдвигается в `right: 1rem, bottom: 6rem` (над bar'ом); `floating` — `right: 1rem, bottom: 1rem`.
  - `src-tauri/src/lib.rs` — два новых command: `open_player_window` (показывает existing или создаёт `WebviewWindow` label `"player"`, `decorations: false`, 360×720, URL `index.html?floating-player=1`), `close_player_window`. В `on_window_event` для `label == "player"` на `CloseRequested` эмиттит `player-window-closed` (НЕ prevent_close — реально закрываем). `tauri-plugin-window-state` авто-сохраняет позицию/размер player-окна между запусками.
  - `src-tauri/capabilities/default.json` — `"windows": ["main", "player"]`, чтобы плавающее окно тоже имело доступ к permissions (events, http, store).
  - **Drag-handle на обложке** (последующее улучшение в этой же сессии):
    - `src/lib/player-drag.ts` — `detectZone(clientX, clientY)` (right/bottom/out по edge-thresholds), `usePlayerDragStore` (active/zone), хук `usePlayerCoverDrag()` через pointer capture; click-vs-drag dead zone 6px; на release переключает `LayoutMode` или (если курсор вне окна) инвокает `open_player_window` со screen-координатами курсора.
    - `src/components/layout/drag-snap-overlay.tsx` — pointer-events-none оверлей с зонами «right card» (22 rem справа) и «bottom bar», подсветка активной зоны под курсором + красный glow по периметру при `zone === "out"`.
    - `player-bar.tsx` / `player-bar-bottom.tsx` — обложка обёрнута div'ом с `onPointerDown` и `cursor-grab` (для floating-режима handler выключен — там OS-titlebar drag).
    - `app-shell.tsx` — монтирует `<DragSnapOverlay />`.
    - `lib.rs` `open_player_window` — добавил optional `x, y: f64` (CSS-пиксели от JS); после build вызывает `set_position(LogicalPosition(x - 180, y - 18))` чтобы окно появлялось центром-сверху на курсоре, перебивая позицию из window-state plugin.
    - `floating-player-sync.tsx` `<FloatingDockWatcher />` — слушает `onMoved` своего окна, debounce 300ms, на остановке сравнивает свой центр с outerPosition/outerSize main-окна; если центр внутри bounds — `invoke("close_player_window")` → main ловит `player-window-closed` и возвращает mode в `right`. Монтируется внутри `<FloatingPlayerSyncReceiver />`.
    - `default.json` — добавил `core:window:allow-outer-position` + `core:window:allow-outer-size` для get-bounds API из JS.
  - **Bottom bar редизайн** — все контролы в одну строку (`[cover/meta] [shuffle/prev/PLAY/next/repeat] [like/lyrics-popover/queue/volume/more]`), прогресс-бар отдельной строкой снизу с временами по краям (intrinsic-width, без `w-10`), чтобы крайние тайм-коды легли ровно под cover-left и more-right. Левый и правый кластеры — `flex-1`, центральный transport всегда дед-центр. Hover на ghost-кнопках перекрыт через arbitrary variant `[&_button[data-variant=ghost]:hover]:bg-white/10` чтобы было translucent-white вместо shadcn-серого. Громкость — vertical popup (`direction="vertical"` proпс на `<VolumeControl>`).
  - **Скругления карточек** унифицированы — `rounded-[10px]` на sidebar-inner, right card, bottom bar.
  - **Скрытие плеера без трека** — все три mode'а гейтят рендер на `hasTrack` (включая spawn floating-окна). Первый запуск с пустой очередью не открывает «Nothing playing» окно.
  - **Кликабельные артисты** — `src/components/shared/artist-links.tsx`, рендерит `<Link>` в main или `<button>` с `emit("nav:artist")` + `invoke("focus_main_window")` в floating; `<AppShell>` слушает `nav:artist` и навигирует. Используется во всех вариантах PlayerBar и в bottom bar.
  - **Floating-окно polish**:
    - Шапка теперь с `bg-surface` (как тело) — без визуального шва.
    - Pin-кнопка слева от close — `getCurrentWindow().setAlwaysOnTop(pinned)`, состояние в `useLayoutStore.floatingPinned` (persist), переживает close→reopen. Permission `core:window:allow-set-always-on-top`.
    - `min_inner_size` поднял до `(320, 560)` чтобы Play/Pause всегда был виден.
    - Обложка получила `mx-auto w-full max-w-[20rem]` — кэп 320px. В правой карточке no-op (там и так 320 после padding'а), в floating не даёт обложке раздуться при широком окне.
    - Верхний `pt-0` в floating-варианте PlayerBar — обложка теперь сидит флаш под title bar.
  - **Cross-window drag-визуализация** — `<FloatingDockWatcher>` на каждом `onMoved` считает свой центр в логических CSS-координатах main-окна и эмиттит `drag:floating-position`; `<FloatingPlayerSync>` (main) слушает и заливает `usePlayerDragStore` (`setActive`/`setCursor`/`setZone(detectZone(x,y))`). Существующий `<DragSnapOverlay>` подсвечивает зоны без модификаций. На idle (300ms) — `drag:floating-end` сбрасывает store.
  - **Drag-overlay редизайн** — вместо dashed-rect зон две градиент-полосы у правого/нижнего краёв с opacity и шириной, растущими по proximity курсора (`PROXIMITY_RANGE_PX = 240`, `STRIP_BASE_PX/BOOST_PX`), плюс inset-shadow по периметру для `zone === "out"`. Тон приглушён (стопы `var(--brand) 60% → 12% → 0`, max opacity 0.25 при подноске, 0.5 в зоне).
  - **StrictMode listener-leak фикс** — все async `listen(...).then(un => dispose = un)` (включая `audio-engine.ts:tray-action`, `app-shell.tsx:player-window-closed/nav:artist`, `floating-player-sync.tsx:playback:action/track-source:action/playback:request-snapshot/playback:state/track-source:state/drag:floating-*`) обёрнуты в `cancelled`-флаг паттерн: если cleanup отработал до резолва promise, `un()` зовётся сразу. Без этого в dev-сборке листенеры дублировались, и `playback:action {type:"toggle"}` диспатчился дважды → `playing` флипался дважды → no-op. То же для `cycleRepeat` / `toggleMute`.
- [x] **6. Добавить кнопку More для карточки плеера**
  - `src/components/layout/player-more-menu.tsx` — `<PlayerMoreMenu>` с прoпсами `track`, `includeSource`, `align`, `side`. Внутри собирает actions через `useTrackMenuController` + `<TrackMenuItems>` (тот же набор, что и у right-click меню на треках: Play, Play next, Add to queue, Start radio, Add to / Remove from liked, Not interested, Add to playlist › sub-menu, Go to artist) + опционально Source-section (Song/Video через `findAlternateVideoId`). При `track === undefined` рендерит disabled trigger (хуки React Query внутри controller'а нельзя условно скипать).
  - **Расщепление по окнам** — `<PlayerMoreMenu>` делится на `<PlayerMoreMenuMain>` (зовёт `useNavigate()` для Go to artist) и `<PlayerMoreMenuFloating>` (callback эмиттит `nav:artist` + `focus_main_window`); `isFloatingPlayerWindow()` фиксирован per window, поэтому per-instance hook order не нарушается.
  - `track-context-menu.tsx` `<TrackMenuItems>` — внутренний `useNavigate()` заменён на required prop `onGoToArtist: (id) => void`. Существующие caller'ы (`<TrackContextMenu>` для правого клика и `<TrackMoreMenu>` для трёх-точек на строке) сами зовут `useNavigate()` и пробрасывают callback.
  - `<PlayerBar>` (right + floating): More-кнопка добавлена в bottom row рядом с Source toggle (`includeSource={false}`).
  - `<PlayerBarBottom>`: More-кнопка с `includeSource={true}` (segmented Source toggle inline не помещается, поэтому Source items живут внутри меню).
  - Rust команда `focus_main_window` — `app.get_webview_window("main").show()/unminimize()/set_focus()`. Используется при artist-link / Go to artist кликах из floating, чтобы main-окно вышло на передний план.
- [ ] **7. Улучшить шапку для страницы плейлиста**
- [x] **8. Придумать что делать со страницей профиля**
- [ ] **9. Дополнить вкладку Settings**
- [x] **10. Переработать панель Queue**
  - `src/components/layout/queue-panel.tsx` расщеплён: `<QueueBody>` (чистый header + scrollable секции history/now-playing/up-next, optional `onClose`), `<QueueToggleButton>` (контролируемая кнопка для inline-оверлея), `<QueuePopover>` (self-contained ghost-button + Popover, как `<LyricsPopover>` — `align="end" side="top" sideOffset={12}`, 28×28 rem). Sheet-вариант удалён.
  - `player-bar.tsx` (right + floating): добавил `const [queueOpen, setQueueOpen] = useState(false)`. В layout карточки между error-баннером и `wrapperClass`-flex-col'ом рендерится `queueOpen ? <QueueBody onClose={...}> : null` как flex-1 sibling; cover/meta/progress/transport-блок и `<LyricsBody>` гейтятся `!queueOpen` (top-блок через `cn(..., queueOpen && "hidden")`, lyrics — условный рендер). Нижний ряд экшенов остаётся всегда видимым, кнопка `<QueueToggleButton open onToggle>` заменила старый `<QueuePanel />`.
  - `player-bar-bottom.tsx`: `<QueuePanel />` → `<QueuePopover />`. Popover `align="center"` (центрирован относительно queue-кнопки; Radix-collision сам сдвигает влево, если правый край упирается в окно).
  - **Drag-and-drop в Up next**: store получил `moveTrack(from, to)` (splice + коррекция `index`, чтобы активный трек оставался текущим даже когда его двигают или вокруг него). В floating-режиме action-override эмитит `playback:action {type:"moveTrack", from, to}`, `<FloatingPlayerSync>` диспатчит. Только секция Up next имеет `draggable` — history и now-playing нет (перетаскивание прошлого в будущее семантически странное). Визуал: `GripVerticalIcon` слева в group-hover, `opacity-40` на исходной строке во время drag, brand-полоса `before:` сверху таргет-строки. Реализация на нативном HTML5 drag — `dataTransfer.setData("text/plain", videoId)` на старт, индексы хранятся в локальном `useState` `<QueueBody>`.
- [ ] **11. Обновить и улучшить дизайн прогресс-бара трека**
- [ ] **12. Добавить локальный поиск в плейлистах**
- [ ] **13. Переработать светлую тему**
- [ ] **14. Поменять цвет дропдаунов и контекстных меню**
- [ ] **15. Поддержать «псевдо-плейлисты» (long-form video с таймкодами) на странице плейлиста** — YT Music авто-генерирует playlist-страницу из таймкодов в описании длинного видео. Сейчас в шелфе клик запускает само видео (см. `playableVideoId` в `ShelfItem`), но `/playlist/$id` для таких ID отдаёт пустоту. Нужно: парсить description, разбивать таймкоды на «треки» с offset'ами, при клике на трек делать seek внутри одного и того же видео.

## Как пользоваться

- В начале новой сессии: «продолжай по `docs/plan.md`» — и я подхвачу контекст.
- Для крупного пункта сначала входим в `plan mode`, прорабатываем подшаги, записываем их сюда, потом реализуем.
- Заметки и решения по конкретному пункту складываем под ним вложенным списком, чтобы не плодить отдельные документы.
