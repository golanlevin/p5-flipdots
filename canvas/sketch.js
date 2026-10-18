/** Set to false for a browser-only preview. Run flipdot_server.js or flipdot_server.py to transmit. */
const ENABLE_TX = true;

let capture;

function setup() {
    // One pixel sample per canvas pixel keeps rasterization predictable on Retina displays.
    pixelDensity(1);
    createCanvas(NUM_COLS * 28, NUM_ROWS * 28);
    frameRate(15);
    // capture = createCapture(VIDEO);
    // capture.size(28 * 28, 14 * 28);
    // capture.hide();
}

function draw() {


    background(220);
    fill('black');
    stroke('black');
    ellipse(mouseX, mouseY, mouseX);

    // capture.loadPixels();
    // for (let y = 0; y < capture.height; y++) {
    //     for (let x = 0; x < capture.width; x++) {
    //         let index = (x + y * capture.width) * 4;
    //         let r = capture.pixels[index];
    //         let g = capture.pixels[index + 1];
    //         let b = capture.pixels[index + 2];
    //         let brightness = (r + g + b) / 3;
    //         if (brightness > 127) {
    //             capture.pixels[index] = 255;
    //             capture.pixels[index + 1] = 255;
    //             capture.pixels[index + 2] = 255;
    //         } else {
    //             capture.pixels[index] = 0;
    //             capture.pixels[index + 1] = 0;
    //             capture.pixels[index + 2] = 0;
    //         }
    //     }
    // }
    // capture.updatePixels();
    // image(capture, 0, 0);

    canvas2display();
}

