# Состояние выпуска

## Владеет

Типы пакетов, кандидат, SQLite, производные артефакты и кэш.

## Не владеет

Не задаёт содержание сценария, лицензионные критерии или оценку качества; описывает идентичность и форму данных.

## Ссылки на смежные домены

[Реестр доменов](README.md)

## STATE-01

Планирование --plan-only выбирает кандидата и сохраняет plan.json без сборки. При смене кандидата согласовать plan/candidate/shorts.sqlite/артефакты как единое изменение, сохранить superseded и инвалидировать зависимые шаги. Квитанции другого кандидата не переносить. Автоматическая транзакционность пока не гарантирована: до resume нужна явная сверка идентификаторов и входов.

## STATE-02

| Тип и стадия | Контракт пакета |
| --- | --- |
| normal assets | shorts/runs/tomorrow-<date>/prepared.json, script.json, проверенные media и visual-material.json; native hook.text, beats[].speech, cta.text |
| normal early | preproduction-input.json, source-verification.json и штатные preproduction receipts |
| creative assets | data/work/auto-<date>/script.json, shots.json, rights.json, factcheck.md; строки lines[].text |

Нельзя требовать creative-пакет от normal. Attribution может быть вложенной; реальный SHA-1 и тип изображения сверяются, портрет не считается фото места.

## STATE-03

storyPhotos/storyPhotoFraming и shots.json согласуются до preview: objectPosition/photoFrame/photoLabelTop/captionsTop переносятся в производные и проверяются после пересборки. Выпуск-специфичные storyCoverPlaque/storyCoverPhoto/captionPhrases/compactCaptionPhrases/storyPhotos/storyPhotoFraming/routeFinaleLayout живут только в данных data/daily/YYYY-MM-DD/, не в общих scripts/*.mjs.

## STATE-04

Кэш pass сохраняется только при совпадении входов, артефактов, схемы, политики и модели; смена текста, фото, framing или кандидата инвалидирует зависимые этапы. После freeze нельзя менять script/shots/rights без нового цикла зависимых проверок.
