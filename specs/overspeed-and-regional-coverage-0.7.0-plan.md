# План реализации 0.7.0

Основание: [готовое ТЗ](overspeed-and-regional-coverage-0.7.0.md), явное поручение владельца реализовать и выпустить. Это план зависимостей; перечисленные проверки до исполнения не считаются пройденными.

1. REQ001–007 / AC001–004: независимое пространство warning policy/preferences, raw threshold и display boundary; audio single-underlying-flight, outcome-unknown quarantine, ограниченный retry и дедупликация подходов. Выполняет инженер runtime после завершённой read-only роли совета.
2. REQ008–009,011,013 / AC005/008: native RHMI параметры, рекомендованный профиль по явному нажатию, ручные controls, честная доступность аудио, полный frozen report и reset GPS. Выполняет инженер UI; не меняет core или версии.
3. REQ010–011 / AC006: Node8 orientation/coverage helpers, host per-record ledger и исключения источников, воспроизводимость отчёта и неизменность dataset. Выполняет инженер данных; не изменяет доказанные лимиты или manifests.
4. REQ002/004/006/008/012/013: координатор интегрирует service, settings, card/raster и всю decoder/provider/guidance цепочку reset с поколениями/cutoff; пишет реальные IPC/transport проверки.
5. Requirement review: сверить каждую AC с фактическим тестом/проверкой окончательной ревизии. Повторно проверить найденные runtime/audio дефекты, frozen diagnostics, source coverage и миграцию. Совпадение мнений не заменяет результат.
6. Выполнить актуальные `npm test`, native/runtime UI проверки на официальном Node8.17, `node tools/build.js`, `node tools/test_packages.js`, `npm run test:repro`. Проверки машины — отдельно, не выдумывать их.
7. Подготовить проверенный источник/пакеты; commit и push; опубликовать два immutable компонента0.7.0, затем catalog. Сверить публичные файлы и SHA через существующий Updater reader/короткий источник, сохранить publication-result вне исходного дерева. Снимок базы2026.11.7.2 и оба data manifest остаются прежними, если новых проверенных фактов нет.

Границы владения файлами согласованы отдельно: UI, runtime-policy/audio и data helpers не пересекаются; общие service/GPS/raster/version/release редактирует координатор. После реализации другой участник проверяет конкретные спорные AC read-only; прежняя council-роль автора кода не считается независимым ревью этого кода.
