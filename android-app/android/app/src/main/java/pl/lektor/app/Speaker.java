package pl.lektor.app;

import java.util.List;

/** Wspólny interfejs silników mowy. Wszystkie metody i zwrotne wywołania działają na wątku głównym. */
interface Speaker {

    final class Item {
        final String id;
        final String text;

        Item(String id, String text) {
            this.id = id;
            this.text = text;
        }
    }

    interface Callback {
        void onStart(String id);

        /** Zakres znaków aktualnie czytanego słowa w tekście zdania. */
        void onRange(String id, int start, int end);

        /** Naturalne zakończenie zdania. */
        void onDone(String id);

        void onBuffering(String id, boolean buffering);

        void onError(String id, String message, boolean network);
    }

    void setVoice(String voice, String locale);

    void setRate(float rate);

    /** Czyta od items[from] do końca listy albo do stop(). */
    void start(List<Item> items, int from);

    /** Wstrzymuje czytanie. */
    void pause();

    /** Wznawia po pause(). Zwraca false, jeśli silnik nie umie wznowić w środku zdania (trzeba wywołać start). */
    boolean resume();

    void stop();

    void release();
}
