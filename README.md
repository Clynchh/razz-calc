# Seven Card Stud 3rd Street — Opening Threshold

**Use it:** https://clynchh.github.io/razz-calc/

Three calculators, one per stud game, linked to each other from the top of each page:

| Page | Game | Grid |
| --- | --- | --- |
| [Razz](https://clynchh.github.io/razz-calc/) | Razz (A-5 lowball) | downcard pairs per upcard |
| [Stud](https://clynchh.github.io/razz-calc/stud.html) | Seven Card Stud (high) | 13x13, suited above the diagonal |
| [Stud Hi-Lo 8](https://clynchh.github.io/razz-calc/stud8.html) | Stud Hi-Lo, 8 or better | 13x13, suited above the diagonal |

Enter the six upcards in seat order (the bring-in is always rightmost), pick your seat, and every starting hand is marked **complete** or **fold**, with its EV in cents against folding.

- Stakes: ante $0.15, bring-in $0.30, small bet $1, big bet $2. Each page plays six-handed, three-handed or heads-up (the **Players** switch); a table size's data downloads the first time you pick it.
- **Raw averages** shows every hand's all-in equity with no board, at the chosen table size.
- On the stud pages each upcard has a suit. Suited combos are exact against the board, and a suited hand's EV moves with how many cards of its suit are showing elsewhere (worth roughly +16c with none showing and −28c with three or more, six-handed).
- Each hand is priced with 4th–7th street played out: callers estimate their chances against the bettor's whole range and call on pot odds.
- Opponents' call and raise rates on 3rd street are fixed estimates per upcard, not solved — treat results as a strong guide, not a perfect-play solver. Razz's are measured from a solve; the stud games' are derived (see below).
- In the stud grids, *suited* means all three cards share a suit; everything else is offsuit.

The pages run entirely in your browser. The first load downloads about 26 MB of precomputed tables for razz and about 83 MB for each stud game.

## Building the tables

The stud data in `data/stud` and `data/stud8`, and razz's three-handed and heads-up data in `data/razz`, comes from the engine in `engine/stud` (Node 20+, no dependencies; it uses every core). Razz's six-handed tables in `data/` came from the original razz solver.

```
node engine/stud/build.mjs hi all                # stud hi, six-handed   -> data/stud
node engine/stud/build.mjs hl all --seats 3      # stud hi-lo, 3-handed  -> data/stud8/n3
node engine/stud/build.mjs razz all --seats 2    # razz heads-up         -> data/razz/n2
```

`all` runs these steps in order, and each can also be run on its own:

1. `avg`: each starting hand's all-in equity at that table size (against 5, 2 or 1 random hands), which orders ranges.
2. `hu` (stud only): the heads-up all-in equity matrix, one per game for every table size.
3. `rates`: continue and raise rates per upcard. A seat continues when calling a completion beats folding and raises when the raised pot beats the called one. This is decided first on all-in equity, then on a quick realised pass.
4. `real --look 2` and `real --look 4`: realised value with 4th–7th played out. Players bet for value, call on pot odds pricing 2 or 4 streets ahead, and judge each other from their 3rd-street ranges.
5. `suitadj` (stud only): for every suited hand, how its realised value against a caller moves with 0, 1, 2 or 3+ cards of its suit showing on the rest of the board.

Short-handed, the completing range assumed when deriving rates widens from the top 40% of hands (six-handed) to 60% (three-handed) and 80% (heads-up).
