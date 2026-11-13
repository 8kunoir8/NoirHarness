###############################################################################


	characters.png — the office cast
	based on the Metro City free top-down character pack by JIK-A-4
	composited with the pixel-agents wardrobe renderer

			------------------------------

	The pixel art is based on the work of JIK-A-4, "Metro City" free top-down
	character pack:
	  https://jik-a-4.itch.io/metrocity-free-topdown-character-pack
	Its author publishes it as completely free to use.

	The six sheets were composited offline from the wardrobe PNGs of
	pixel-agents (https://github.com/pixel-agents-hq/pixel-agents) with that
	project's own layout code (MIT, Copyright (c) 2026 Pablo De Lucca). No sprite
	was edited by hand.

			------------------------------

	Atlas layout, for anyone regenerating or extending it:

	  sheet  128 x 96 per character, six characters side by side => 768 x 96
	         sheet width 128 = 8 frames x 16 px
	         sheet height 96 = 3 rows x 32 px
	  rows   down, up, right   (left is `right` mirrored with flipX)
	  clips  walk [0,1,2,1], type [3,4], read [5,6], seated [7]

	Characters, left to right: Suit, Dress, Spike, Aura, Tidy, Bob.

	The manifest in this directory is the contract; this file only records how
	the atlas was produced.


###############################################################################
