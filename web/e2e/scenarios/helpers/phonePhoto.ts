import sharp from 'sharp';

// A phone-size photo (CUR-2633): 4032×3024, the same blue circle on JPEG-hostile noise, saved at
// quality 92 so it comes to 6.2 MB, the size of a full-resolution photo from a recent phone. That is
// over chat's 3 MB per message and over Vercel's 4.5 MB request cap, so it only gets through if the
// browser shrinks it. The noise is seeded, so every run sends the same bytes.
export async function phonePhotoJpeg(): Promise<Buffer> {
	const W = 4032;
	const H = 3024;
	const noise = Buffer.alloc(W * H * 3);
	let seed = 7;
	for (let i = 0; i < noise.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		noise[i] = seed % 256;
	}
	const circle = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
		<circle cx="${W / 2}" cy="${H / 2}" r="1100" fill="#1040d0"/>
	</svg>`;
	return sharp(noise, { raw: { width: W, height: H, channels: 3 } })
		.composite([{ input: Buffer.from(circle) }])
		.jpeg({ quality: 92 })
		.toBuffer();
}
