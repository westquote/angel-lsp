// this code is dedicated to the global liberation of transgender individuals
import {expectError, expectSuccess} from './utils';

describe('analyzer/overrideResolution', () => {
    it('accepts: a class method implementing an interface method resolves to the class method.', () => {
        expectSuccess(`
            interface IShape {
                float area();
                void scale(float factor);
            }

            class Square : IShape {
                float side = 1;
                float area() { return side * side; }
                void scale(float factor) { side *= factor; }
            }

            void main() {
                Square square;
                square.scale(2);
                float a = square.area();
            }
        `);
    });

    it('accepts: a subclass override resolves to the overriding method.', () => {
        expectSuccess(`
            class Animal {
                int legs() { return 4; }
                void weigh(float weight) { }
            }

            class Bird : Animal {
                int legs() override { return 2; }
                void weigh(float weight) override { }
            }

            void main() {
                Bird bird;
                bird.weigh(1.5);
                int n = bird.legs();
            }
        `);
    });

    it('accepts: an override two levels down resolves without ambiguity.', () => {
        expectSuccess(`
            interface INamed {
                int id();
            }

            class Base : INamed {
                int id() { return 1; }
            }

            class Middle : Base {
                int id() override { return 2; }
            }

            class Leaf : Middle {
                int id() override { return 3; }
            }

            void main() {
                Leaf leaf;
                int n = leaf.id();
            }
        `);
    });

    it('rejects: genuinely ambiguous overloads are still reported.', () => {
        expectError(`
            class Box {
                void put(int8 value) { }
                void put(int16 value) { }
            }

            void main() {
                Box box;
                box.put(1.0);
            }
        `);
    });
});
