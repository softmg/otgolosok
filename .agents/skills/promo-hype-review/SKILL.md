---
name: promo-hype-review
description: Оценивать сюжет, сценарий и готовый проморолик Отголоска по критериям хайповости otgolosok-creative, сохраняя маршрутный финал по PACK-02. Применять при просьбах проверить хайповость, крючок, удержание или соответствие ролика критериям creative; подходит и для сценария до озвучки, и для готового выпуска otgolosok-shorts.
---

# Оценка хайповости проморолика

Оцени выпуск для широкой ленты Shorts по [EDIT-03](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-03) и [EDIT-04](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-04). Формат «история + маршрут» и финал определяет [PACK-02](../../../../otgolosok-shorts/assets/promo-review/packaging.md#pack-02).

Для подробной проверки начала применяй соседний `video-hook-review`; его результат включай в полный аудит по [VERIFY-03](../../../docs/instructions/verification.md#verify-03).

## На что опираться

Найди корни соседних репозиториев `otgolosok`, `otgolosok-shorts` и `otgolosok-creative`. Пути ниже указаны от их корней, а не от папки скилла.

Нормативные критерии — в ссылках этого навыка. `otgolosok-creative/scripts/rank.mjs`, `scripts/rules.mjs` и README используй для сверки исполняемого контракта; при недоступности исходников укажи ограничение. `rank.mjs` делает платные запросы по всему пулу, поэтому для оценки одного выпуска его запуск не нужен.

Для указанного выпуска найди доступные материалы:

- `story-options.json` — варианты, оценки и выбранный сюжет;
- `script.json`, `prepared.json`, снимок прогулки — текст, факты, источники и фотографии;
- `storyboard.json` → `board.scene` — слова с таймкодами, начало маршрутной части, смена снимков;
- фактически собранный MP4, `probe.json`, `promo-video.json` и обложка. Итоговый `promo-video.mp4` может быть длиннее исходного `video.mp4`;
- заголовок, описание и опубликованные на канале темы, если требуется оценить упаковку и новизну.

Сверь сохранённый снимок истории с текущим текстом. Область и достоверность аудита: [VERIFY-03](../../../docs/instructions/verification.md#verify-03).

## Сюжет

Применяй [EDIT-03](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-03) и [EDIT-04](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-04). Зафиксируй факты, необходимые для завязки и развязки, пробелы источников и возможные альтернативы из той же прогулки.

## Текст и упаковка

Сверь цепочку «утверждение → факт → источник» по [EDIT-01](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-01), интригу и сюжетную работу имён, терминов и годов — по [EDIT-03](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-03), выполнение обещания — по [EDIT-04](../../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-04).
Титры проверяй по [PACK-01](../../../../otgolosok-shorts/assets/promo-review/packaging.md#pack-01), обложку на размере значка — по [PACK-02](../../../../otgolosok-shorts/assets/promo-review/packaging.md#pack-02).

## Готовое видео

Проверь основной кадр по [VIS-02](../../../../otgolosok-shorts/assets/promo-review/visual.md#vis-02), вклад визуала в начало и выборку кадров — по [VIS-05](../../../../otgolosok-shorts/assets/promo-review/visual.md#vis-05). В автоматическом аудите сопоставь `hookVisual`/`visualHook` с отдельными полями `video`/`visualEvidence`; допуск определяет [VERIFY-01](../../../docs/instructions/verification.md#verify-01).
Субтитры сверяй по [PACK-01](../../../../otgolosok-shorts/assets/promo-review/packaging.md#pack-01), звуковые переходы — по [AUDIO-02](../../../../otgolosok-shorts/assets/promo-review/audio.md#audio-02).

Если извлекаешь кадры через FFmpeg в SSH-скрипте, используй `-nostdin`; иначе он может прочитать следующие команды скрипта как интерактивный ввод.

## Маршрутный финал

Измерение и критерии финала — [PACK-02](../../../../otgolosok-shorts/assets/promo-review/packaging.md#pack-02). Сверь `board.scene.ctaAt` с фактической речью и кадром перехода; длительность бери из конечного файла. Для черновика укажи предварительную оценку по [VERIFY-03](../../../docs/instructions/verification.md#verify-03).

Пример сокращения для соответствующей прогулки: «В прогулке семнадцать остановок. Начало — у Красных Ворот. Ссылка в описании». Проверяй данные конкретного маршрута.
Вопрос и его место в описании/комментарии — [PACK-03](../../../../otgolosok-shorts/assets/promo-review/packaging.md#pack-03). Условия выпуска и повторного аудита — [VERIFY-01](../../../docs/instructions/verification.md#verify-01), [VERIFY-03](../../../docs/instructions/verification.md#verify-03).

## Как выдать оценку

Дай редакционный вердикт: «готов», «нужны точечные правки» или «нужна переработка». Отдельно оцени **сюжет, текст и видео по шкале 1–10**, объяснив оценки конкретными наблюдениями. Применяй [VERIFY-03](../../../docs/instructions/verification.md#verify-03) к баллам и непроверенным частям. Оценку модели из отбора приводи отдельно.

Покажи компактную таблицу «критерий → наблюдение/таймкод → правка». Отдельно укажи длительности истории, всего финала и полного MP4; для черновика — предварительную оценку. Выдели 2–3 правки с наибольшим влиянием на удержание, приведи более сильный крючок и сокращённый маршрутный текст, если факты позволяют. Не скрывай нарушение фактической точности или незакрытое обещание крючка за высоким средним баллом.

Полномочия аудита и порученных исправлений — [VERIFY-03](../../../docs/instructions/verification.md#verify-03).
