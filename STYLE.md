# Futuristic Dashboard – Style Guide

## Overall Vibe
Mörkt "sci-fi command center"-tema (cyberpunk/HUD-känsla) med glaseffekt (glassmorphism),
mjuka glow-effekter och en subtil bakgrundstextur (svaga vertikala ljuspartiklar/grid).

## Färgpalett
- Bakgrund: nästan svart, mörk marinblå (~#05070D till #0B0F1A)
- Panel/kort-bakgrund: halvtransparent mörkblå (~rgba(15,20,35,0.6)) med tunn ljus/cyan kant (1px, låg opacitet)
- Primär accent: cyan/turkos (~#22D3EE)
- Sekundär accent: lila/magenta (~#A855F7 till #EC4899), används i gradienter (t.ex. minnesanvändning)
- Statusfärger: grön (aktiv/success, ~#22C55E), gul/orange (varning, ~#F59E0B), blå (info, ~#3B82F6), röd (kritiskt)
- Text: vit/nästan vit för rubriker, ljusgrå/slate för brödtext och sekundär info

## Typografi
- Sans-serif, modern (typ Inter/Geist)
- Stora siffror (t.ex. "49%", "39%") i fetstil, vit
- Sektionsrubriker i versaler med bokstavsmellanrum (t.ex. "SYSTEM STATUS", "QUICK ACTIONS")
- Sekundär text (tider, enheter) mindre och gråare

## Layout
- Tre-kolumns dashboard-grid: vänster sidomeny (smal), mittkolumn (bred, huvudinnehåll), höger kolumn (widgets)
- Rundade hörn på alla kort (~8–12px radius)
- Generöst med padding inuti kort, tydlig luft mellan sektioner
- Subtil border/glow runt paneler istället för tunga skuggor

## Komponenter

### Kort/paneler
Halvtransparent mörk bakgrund, tunn ljus kant, rundade hörn, ikon uppe till höger i statuskort
(t.ex. CPU/Memory/Network), stor siffra + liten beskrivande text under.

### Knappar
- **Ikonknappar (Quick Actions):** kvadratiska, ikon centrerad ovanför text-label, tunn border,
  cyan hover-glow, mörk bakgrund
- **Statusbadge ("LIVE"):** pillerformad, grön prick + text, halvtransparent grön bakgrund
- **Små badges ("Active"):** pillerformad, grön text på mörkgrön halvtransparent bakgrund

### Toggles (Environment Controls)
Pillerformade switchar – cyan/vit när aktiverad, mörkgrå track när avstängd, mjuk övergång.

### Progressbars
Tunna rundade staplar; vissa i en enda accentfärg (cyan), andra med gradient
(cyan → magenta) för att visa allokering/användning i procent.

### Sidomeny
Vertikal lista med ikon + label, aktivt val markerat med ljus bakgrundston + cyan text/ikon,
resten i neutral grå.

### Diagram
Linje-/areadiagram med glödande linje, subtila rutnätslinjer, tooltip-liknande popover
som visar aktuellt värde ("System Load 49%").

### Loggar/listor (Communications, Alerts)
Rad-baserad lista med liten avatar/ikon-cirkel, rubrik + tidsstämpel till höger,
kort beskrivande text under, färgad prick för olästa/status.

## Effekter
- Glassmorphism: halvtransparenta ytor med suddig bakgrund
- Glow: mjuk ljuseffekt runt accentfärgade element (ikoner, aktiva knappar, diagramlinjer)
- Subtil bakgrundsanimation/partiklar för djup

## Rekommenderade CSS-värden att utgå från
- Border-radius: 8–16px
- Accentfärg: `#22D3EE` (cyan), `#A855F7` (lila) för gradienter
- Bakgrund: `#05070D` – `#0B0F1A`
- Font: Inter, system-ui, sans-serif
